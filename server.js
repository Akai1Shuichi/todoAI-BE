import { spawn } from "child_process";
import cors from "cors";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT ?? 3333);
const DEFAULT_REPO_PATH = process.env.DEFAULT_REPO_PATH
  ? path.resolve(process.env.DEFAULT_REPO_PATH)
  : path.resolve(__dirname, "..");
const CODEX_BIN = process.platform === "win32" ? "codex.cmd" : "codex";

const jobs = new Map();

app.use(cors());
app.use(express.json());

function parseTodoMarkdown(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^- \[( |x)\]\s+(\d+(?:\.\d+)*)\s+(.+)$/i);

      if (!match) {
        return null;
      }

      return {
        id: match[2],
        title: match[3].trim(),
        status: match[1].toLowerCase() === "x" ? "done" : "pending",
        line: index + 1,
      };
    })
    .filter(Boolean);
}

async function loadTasksFromRepo(repoPath) {
  const todoFile = path.join(repoPath, "todo.md");
  const content = await fs.readFile(todoFile, "utf8");
  return {
    tasks: parseTodoMarkdown(content),
    todoFile,
  };
}

function pushLog(jobId, message) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.logs.push(message);
  job.updatedAt = Date.now();
}

function shouldHideCodexTraceLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed === "exec") {
    return true;
  }

  if (
    trimmed.includes("\\WindowsPowerShell\\") &&
    trimmed.includes(" -Command ") &&
    trimmed.includes(" in ")
  ) {
    return true;
  }

  return false;
}

function pushFilteredCodexOutput(jobId, chunk) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const text = `${job.pendingOutput ?? ""}${chunk.toString()}`;
  const lines = text.split(/(\r?\n)/);
  let pendingOutput = "";
  let output = "";

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const newline = lines[index + 1] ?? "";

    if (!newline && index === lines.length - 1) {
      pendingOutput = line;
      break;
    }

    if (!shouldHideCodexTraceLine(line)) {
      output += line + newline;
    }
  }

  job.pendingOutput = pendingOutput;

  if (output) {
    pushLog(jobId, output);
  }
}

function finishJob(jobId, status, code) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.status = status;
  job.exitCode = code;
  job.finishedAt = Date.now();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    defaultRepoPath: DEFAULT_REPO_PATH,
  });
});

app.get("/api/tasks", async (req, res) => {
  try {
    const repoPath = req.query.repoPath
      ? path.resolve(String(req.query.repoPath))
      : DEFAULT_REPO_PATH;
    const { tasks, todoFile } = await loadTasksFromRepo(repoPath);

    res.json({
      tasks,
      todoFile,
      repoPath,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to read todo file.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/tasks/load", async (req, res) => {
  try {
    const repoPath = req.body?.repoPath
      ? path.resolve(String(req.body.repoPath))
      : DEFAULT_REPO_PATH;
    const { tasks, todoFile } = await loadTasksFromRepo(repoPath);

    res.json({
      tasks,
      todoFile,
      repoPath,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to read todo file.",
      detail: error instanceof Error ? error.message : String(error),
      repoPath: req.body?.repoPath ?? DEFAULT_REPO_PATH,
    });
  }
});

app.post("/api/tasks/:id/run", async (req, res) => {
  const { id } = req.params;
  const { title, repoPath } = req.body ?? {};
  const normalizedRepoPath = repoPath
    ? path.resolve(String(repoPath))
    : DEFAULT_REPO_PATH;

  let task;
  let todoFile;

  try {
    const data = await loadTasksFromRepo(normalizedRepoPath);
    task = data.tasks.find((item) => item.id === id);
    todoFile = data.todoFile;
  } catch (error) {
    res.status(500).json({
      error: "Failed to read todo file before starting job.",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!task && !title) {
    res.status(404).json({ error: `Task ${id} was not found in todo.md.` });
    return;
  }

  const taskTitle = title ?? task.title;
  const jobId = `${id}-${Date.now()}`;

  jobs.set(jobId, {
    id: jobId,
    taskId: id,
    title: taskTitle,
    repoPath: normalizedRepoPath,
    todoFile,
    status: "running",
    logs: [],
    pendingOutput: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const prompt = [
    `Read todo.md and implement task ${id}: ${taskTitle}.`,
    `Use the todo.md located at ${todoFile}.`,
    "Work only inside the target repository.",
    "After finishing, summarize changed files and key results.",
  ].join(" ");

  const child = spawn(
    CODEX_BIN,
    ["exec", "--cd", normalizedRepoPath, "--skip-git-repo-check", "--full-auto", "-"],
    {
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    }
  );

  child.stdin.write(prompt);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    pushFilteredCodexOutput(jobId, chunk);
  });

  child.stderr.on("data", (chunk) => {
    pushFilteredCodexOutput(jobId, chunk);
  });

  child.on("error", (error) => {
    pushLog(jobId, `Error: ${error.message}\n`);
    finishJob(jobId, "failed", -1);
  });

  child.on("close", (code) => {
    const job = jobs.get(jobId);

    if (job?.pendingOutput && !shouldHideCodexTraceLine(job.pendingOutput)) {
      pushLog(jobId, job.pendingOutput);
    }

    if (job) {
      job.pendingOutput = "";
    }

    finishJob(jobId, code === 0 ? "success" : "failed", code ?? -1);
  });

  res.json({
    jobId,
    status: "running",
    task: {
      id,
      title: taskTitle,
    },
  });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json(job);
});

app.get("/api/jobs/:jobId/stream", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  let cursor = 0;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const flush = () => {
    const nextJob = jobs.get(jobId);

    if (!nextJob) {
      return;
    }

    const nextLogs = nextJob.logs.slice(cursor);
    cursor = nextJob.logs.length;

    for (const log of nextLogs) {
      res.write(`data: ${JSON.stringify({ type: "log", text: log })}\n\n`);
    }

    if (nextJob.status !== "running") {
      res.write(
        `data: ${JSON.stringify({
          type: "done",
          status: nextJob.status,
          exitCode: nextJob.exitCode,
        })}\n\n`
      );
      clearInterval(timer);
      res.end();
    }
  };

  res.write(
    `data: ${JSON.stringify({
      type: "meta",
      status: job.status,
      taskId: job.taskId,
      title: job.title,
      repoPath: job.repoPath,
      todoFile: job.todoFile,
    })}\n\n`
  );

  flush();

  const timer = setInterval(flush, 300);

  req.on("close", () => {
    clearInterval(timer);
  });
});

app.listen(PORT, () => {
  console.log(`Todo Codex Runner listening on http://localhost:${PORT}`);
  console.log(`Default repo path: ${DEFAULT_REPO_PATH}`);
});
