import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import crossSpawn from 'cross-spawn';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { NormalizedMessage, ProviderRuntimeContext, ProviderRuntimeWriter, SideQuestionOutcome, SideQuestionRequest, SideQuestionSink } from '@/shared/types.js';
import { AppError, createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell, readObjectRecord } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

/** Handle registered in the process table, carrying the run's session key. */
type PiProcessHandle = ChildProcess & { sessionId?: string; aborted?: boolean };

/**
 * Process-table entry for the window before the child exists (the resume model
 * is still resolving). It only carries the `aborted` flag: an abort that lands
 * there flags and removes it, and the spawn path checks the flag afterwards —
 * without it, `abort` would report "not running" and the run would go on to
 * spawn pi after the gateway had already closed it.
 */
function createPendingEntry(): PiProcessHandle {
  return Object.assign({} as ChildProcess, { aborted: false });
}

/**
 * Options the pi runtime reads from one run call.
 *
 * `permissionMode` and `effort` are deliberately absent: pi has no permission
 * system and no reasoning-effort lever (see the pi capabilities), so neither
 * option maps to any CLI flag or env var.
 */
type PiRunOptions = {
  sessionId?: string | null;
  projectPath?: string;
  cwd?: string;
  model?: string | null;
  sessionSummary?: string;
  images?: unknown;
  files?: unknown;
};

/** Cumulative per-run usage counters pi attaches to every JSON event. */
type PiUsageCounters = {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

/** Mutable per-run state bag threaded through `processPiOutputLine`. */
type PiOutputContext = {
  ws: ProviderRuntimeWriter;
  sessionId?: string | null;
  getCapturedSessionId(): string | null;
  registerSession(nextSessionId: string): void;
  setUsage(usage: PiUsageCounters): void;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
};

const activePiProcesses = new Map<string, PiProcessHandle>();

/**
 * Builds the `pi -p --mode json` argument vector for one run.
 *
 * Verified against pi 0.85.1:
 * - the prompt is the final positional argument, preceded by `--` so a prompt
 *   that begins with `-` is never parsed as an option (pi treats everything
 *   after `--` as positional messages);
 * - `--session` resumes a provider session with its full uuid (resumed runs
 *   keep the same session id and append to the same session file);
 * - `--model` accepts a bare model id or a `provider/model` pair;
 * - there is no `--dir`/`--cwd` flag — the working directory is the spawn
 *   `cwd` option.
 *
 * Exported for tests only.
 */
export function buildPiArgs({
  providerSessionId,
  model,
  prompt,
}: {
  providerSessionId?: string | null;
  model?: string | null;
  prompt?: string | null;
}): string[] {
  const args = ['-p', '--mode', 'json'];
  if (providerSessionId) {
    args.push('--session', providerSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  if (prompt && prompt.trim()) {
    args.push('--', flattenPromptForWindowsShell(prompt));
  }
  return args;
}

/**
 * Reads the provider-native session id out of one parsed stdout event.
 *
 * Only the `session` header carries an id; the streaming events reference
 * messages and tool calls, never the session.
 */
function readPiSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const candidate = event as { type?: unknown; id?: unknown };
  return candidate.type === 'session' && typeof candidate.id === 'string' ? candidate.id : null;
}

/**
 * Maps pi's cumulative usage counters onto the token-budget shape the chat
 * composer reads (`inputTokens`/`outputTokens`/`used`/`breakdown`, mirroring
 * the opencode runtime), keeping pi's own totals and cost as extra fields.
 *
 * pi reports cache reads separately; like opencode, they count as input.
 */
function readPiTokenBudget(usage: PiUsageCounters | null): {
  used: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: { input: number; output: number };
  totalTokens: number;
  cost?: number;
} | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = Number(usage.input || 0) + Number(usage.cacheRead || 0);
  const outputTokens = Number(usage.output || 0);
  const used = Number(usage.totalTokens || 0) || inputTokens + outputTokens;
  if (used <= 0) {
    return null;
  }

  return {
    used,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
    totalTokens: Number(usage.totalTokens || 0),
    cost: usage.cost && typeof usage.cost === 'object' ? usage.cost.total : undefined,
  };
}

/**
 * Parses one stdout line from `pi -p --mode json` and forwards what it yields.
 *
 * Exported for tests only; the runtime passes a ctx bag because the mutable
 * state (captured session id, last usage) lives in the run closure.
 *
 * - Unparseable lines (pi's own warnings mixed into stdout) stream through as
 *   deltas rather than killing the run.
 * - The `session` header registers the provider-native id (contract: new
 *   provider sessions announce `session_created` once, and the writer learns
 *   the id before any content event).
 * - Every event's top-level `usage` is cumulative, so the last one seen wins.
 * - Event-to-message mapping is `context.normalizeMessage`; the runtime never
 *   interprets event contents itself.
 */
export function processPiOutputLine(line: string, ctx: PiOutputContext): void {
  if (!line || !line.trim()) {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    ctx.ws.send(createNormalizedMessage({
      kind: 'stream_delta',
      content: line,
      sessionId: ctx.getCapturedSessionId() || ctx.sessionId || null,
      provider: 'pi',
    }));
    return;
  }

  try {
    const nextSessionId = readPiSessionId(event);
    if (nextSessionId) {
      ctx.registerSession(nextSessionId);
    }
    if (event && typeof event === 'object') {
      // pi 0.85.x carried usage at the top level; pi 1.4 nests it inside the
      // `message` record (e.g. on `turn_end`). Read both so the run's final
      // accounting still reaches the token-budget status frame.
      const rawUsage = 'usage' in event
        ? (event as { usage?: unknown }).usage
        : readObjectRecord(readObjectRecord((event as { message?: unknown }).message)?.usage);
      if (rawUsage && typeof rawUsage === 'object') {
        ctx.setUsage(rawUsage as PiUsageCounters);
      }
    }
    const normalized = ctx.normalizeMessage(event, ctx.getCapturedSessionId() || ctx.sessionId || null);
    for (const msg of normalized) {
      ctx.ws.send(msg);
    }
  } catch (error) {
    const errorContent = error instanceof Error ? error.message : String(error);
    console.error('[Pi] Failed to process JSON output:', errorContent);
    ctx.ws.send(createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      sessionId: ctx.getCapturedSessionId() || ctx.sessionId || null,
      provider: 'pi',
    }));
  }
}

async function spawnPi(
  command: string,
  options: PiRunOptions = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      model,
      sessionSummary,
      images,
      files,
    } = options;
    // Callers pass the stable app session id; the CLI resumes with the
    // provider-native id recorded on the session row.
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    // Process-map key: the app session id when the caller supplied one, so
    // abort-by-app-id always works.
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let lastUsage: PiUsageCounters | null = null;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let piProcess: PiProcessHandle | null = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // Decoders span chunk boundaries: stdout/stderr arrive in arbitrary Buffer
    // chunks and a multi-byte character can straddle two of them, which a
    // chunk-local `toString()` would render as U+FFFD.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    // Registered before the resume model resolves so abort can reach the run
    // in that window (see createPendingEntry).
    const pendingEntry = createPendingEntry();
    activePiProcesses.set(processKey, pendingEntry);

    const notifyTerminalState = ({ code = null, error = null }: { code?: number | null; error?: string | null } = {}): void => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      // Notifications are app-facing, so they carry the app session id.
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'pi',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'pi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Pi CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId: string): void => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      // Legacy/direct callers without an app session id re-key the process
      // under the provider-native id once it is known.
      if (!sessionId && processKey !== capturedSessionId && piProcess) {
        activePiProcesses.delete(processKey);
        activePiProcesses.set(capturedSessionId, piProcess);
      }
      if (piProcess) {
        piProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'pi',
        }));
      }
    };

    const processCtx: PiOutputContext = {
      ws,
      sessionId,
      getCapturedSessionId: () => capturedSessionId,
      registerSession,
      setUsage: (usage: PiUsageCounters) => {
        lastUsage = usage;
      },
      normalizeMessage: (raw: unknown, normalizedSessionId: string | null) => context.normalizeMessage(raw, normalizedSessionId),
    };

    void context.resolveResumeModel(sessionId ?? undefined, model).then(async (resolvedModel) => {
      // Aborted while the model was still resolving: the gateway already sent
      // this run's terminal complete on the abort path, so spawn nothing and
      // stay silent.
      if (pendingEntry.aborted) {
        resolve();
        return;
      }

      const args = buildPiArgs({ providerSessionId, model: resolvedModel });
      const hasAttachments =
        normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      if ((command && command.trim()) || hasAttachments) {
        // Attachment paths ride along as <images_input>/<files_input> blocks
        // appended to the prompt; the session history reader strips the tags
        // back out. pi is a .cmd shim on Windows, so the whole argument must
        // be newline-free or cmd.exe silently truncates it. The leading `--`
        // keeps a prompt that starts with `-` positional.
        const promptWithAttachments = appendFilesInputTag(
          appendImagesInputTag(command?.trim() || '', images),
          files,
        );
        args.push('--', flattenPromptForWindowsShell(promptWithAttachments));
      }

      piProcess = spawnFunction('pi', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        // pi has no permission levers, so unlike opencode there is no env
        // override to merge here — the user's own pi config governs.
        env: { ...process.env },
      }) as PiProcessHandle;

      activePiProcesses.set(processKey, piProcess);
      piProcess.sessionId = processKey;
      piProcess.stdin?.end();

      piProcess.stdout?.on('data', (data: Buffer) => {
        stdoutLineBuffer += stdoutDecoder.write(data);
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processPiOutputLine(line.trim(), processCtx);
        });
      });

      piProcess.stderr?.on('data', (data: Buffer) => {
        const stderrText = stderrDecoder.write(data);
        if (!stderrText.trim()) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'pi',
        }));
      });

      piProcess.on('close', async (code: number | null) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activePiProcesses.delete(finalSessionId);
        activePiProcesses.delete(processKey);

        // 'close' fires after stdio flushed, so this is the moment to release
        // whatever the decoder still held back before flushing the trailing
        // (newline-less) line.
        stdoutLineBuffer += stdoutDecoder.end();
        if (stdoutLineBuffer.trim()) {
          processPiOutputLine(stdoutLineBuffer.trim(), processCtx);
          stdoutLineBuffer = '';
        }

        // pi reports cumulative usage on every event; the last one seen is
        // the run's final accounting.
        const tokenBudget = readPiTokenBudget(lastUsage);
        if (tokenBudget) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'pi',
          }));
        }

        // Terminal complete — skipped for aborted runs (abort-session
        // already sent the aborted complete on this run's behalf).
        if (!completeSent && !piProcess?.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({
            provider: 'pi',
            sessionId: finalSessionId,
            actualSessionId: capturedSessionId || null,
            exitCode: code,
          }));
        }

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await context.isProviderInstalled();
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'Pi CLI is not installed. Install it from https://pi.dev/',
              sessionId: finalSessionId,
              provider: 'pi',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'pi process was terminated' : `pi exited with code ${code}`));
      });

      piProcess.on('error', async (error: NodeJS.ErrnoException) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activePiProcesses.delete(finalSessionId);
        activePiProcesses.delete(processKey);

        const installed = await context.isProviderInstalled();
        const notInstalled = error.code === 'ENOENT' && !installed;
        const errorContent = !installed
          ? 'Pi CLI is not installed. Install it from https://pi.dev/'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'pi',
        }));
        if (!completeSent && !piProcess?.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'pi', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error: error.message });
        if (notInstalled) {
          reject(new AppError('Pi CLI is not installed. Install it from https://pi.dev/', {
            code: 'PROVIDER_NOT_INSTALLED',
          }));
          return;
        }
        reject(error);
      });
    }).catch((error: unknown) => {
      // Model resolution failed before any child existed: drop the pending
      // entry unless a real process (or an abort) already replaced it.
      if (activePiProcesses.get(processKey) === pendingEntry) {
        activePiProcesses.delete(processKey);
      }
      reject(error);
    });
  });
}

/**
 * The only tool a side question may use: look, never touch. `-t` with a
 * plain list replaces pi's defaults, so bash/edit/write and every extension
 * tool stay off — the read-only restriction Claude buys with `tools:` rides
 * on the CLI's own allowlist here.
 */
const PI_SIDE_QUESTION_TOOLS = 'read';

/**
 * A short instruction appended to pi's own system prompt so the fork knows it
 * is answering a side question, not continuing the conversation. Mirrors the
 * Claude BTW append verbatim.
 */
const PI_SIDE_QUESTION_SYSTEM_PROMPT_APPEND =
  'This is a side question asked apart from the ongoing conversation, on a read-only '
  + 'copy of it. Do not use any tool that changes anything. Answer briefly, in the '
  + 'language the question was asked in.';

/**
 * Builds the `pi -p --mode json --fork …` argument vector for one side
 * question. Verified against pi 1.4:
 * - `--fork <id>` copies the provider session's transcript into a fresh
 *   session, so the main conversation's file is never appended to;
 * - `--no-mcp` keeps the fork from starting the user's MCP servers (the
 *   isolation Claude's strictMcpConfig buys);
 * - `-t read` is the read-only allowlist above.
 *
 * Exported for tests only.
 */
export function buildPiSideQuestionArgs({
  providerSessionId,
  model,
  question,
}: {
  providerSessionId?: string | null;
  model?: string | null;
  question: string;
}): string[] {
  const args = ['-p', '--mode', 'json'];
  if (providerSessionId) {
    args.push('--fork', providerSessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  args.push('--no-mcp', '-t', PI_SIDE_QUESTION_TOOLS);
  args.push('--append-system-prompt', PI_SIDE_QUESTION_SYSTEM_PROMPT_APPEND);
  args.push('--', flattenPromptForWindowsShell(question));
  return args;
}

/**
 * Answers one side question on a read-only fork of the session's pi
 * transcript (or a fresh session when the app session has no provider id
 * yet, the same fallback Claude's fork path takes).
 *
 * Deliberately shares nothing with a main run's machinery: no ws writer, no
 * `activePiProcesses` entry (its keys are main-run session ids), no run
 * lifecycle notifications — the side-questions service owns the events. A
 * dismiss kills the child through `request.signal`; the service races that
 * abort on its side, so the outcome resolved here after a kill is discarded.
 * Never rejects: every failure comes back as an `error` outcome.
 */
async function askPiSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
): Promise<SideQuestionOutcome> {
  const { providerSessionId, projectPath, question, model, signal } = request;
  const workingDir = projectPath || process.cwd();
  const args = buildPiSideQuestionArgs({ providerSessionId, model, question });

  return new Promise<SideQuestionOutcome>((resolve) => {
    let answer = '';
    let streamError: string | null = null;
    let settled = false;
    let stdoutLineBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');

    const settle = (outcome: SideQuestionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const onAbort = (): void => {
      child?.kill('SIGTERM');
    };
    if (signal.aborted) {
      settle({ status: 'error', error: 'aborted', answer: '' });
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const child = spawnFunction('pi', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as PiProcessHandle;
    child.stdin?.end();

    /**
     * One parsed stdout line. Only the assistant text channel and pi's error
     * signals matter here; everything else (session header, tool activity,
     * turn bookkeeping) belongs to the fork, not the answer.
     */
    const processLine = (line: string): void => {
      if (!line.trim()) {
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return; // pi's own stdout warnings are not part of the answer
      }
      const record = readObjectRecord(event);
      if (!record) {
        return;
      }

      if (record.type === 'message_update') {
        const update = readObjectRecord(record.assistantMessageEvent);
        if (update?.type === 'text_delta' && typeof update.delta === 'string' && update.delta.length > 0) {
          sink.delta(update.delta);
          answer += update.delta;
        }
        return;
      }

      // pi exits 0 even when the model call failed; the error only shows up
      // as stopReason/errorMessage on the assistant message.
      if (record.type === 'message_end') {
        const message = readObjectRecord(record.message);
        if (message?.stopReason === 'error') {
          streamError = typeof message.errorMessage === 'string' && message.errorMessage
            ? message.errorMessage
            : 'Pi failed to answer the side question.';
        }
        return;
      }

      if (record.type === 'extension_error') {
        streamError = typeof record.error === 'string' && record.error
          ? record.error
          : typeof record.errorMessage === 'string' && record.errorMessage
            ? record.errorMessage
            : streamError;
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      stdoutLineBuffer += stdoutDecoder.write(data);
      const completeLines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = completeLines.pop() || '';
      completeLines.forEach((line) => processLine(line.trim()));
    });

    // stderr stays unparsed: a side question has no chat surface to stream
    // diagnostics onto, and close/error below already carry the exit story.
    child.on('close', (code: number | null) => {
      stdoutLineBuffer += stdoutDecoder.end();
      if (stdoutLineBuffer.trim()) {
        processLine(stdoutLineBuffer.trim());
      }

      if (signal.aborted) {
        settle({ status: 'error', error: 'aborted', answer });
        return;
      }
      if (streamError) {
        settle({ status: 'error', error: streamError, answer });
        return;
      }
      if (code !== 0) {
        settle({ status: 'error', error: code === null ? 'pi process was terminated' : `pi exited with code ${code}`, answer });
        return;
      }
      if (answer.length > 0) {
        settle({ status: 'done', answer });
        return;
      }
      settle({ status: 'error', error: 'Pi returned no answer.', answer: '' });
    });

    child.on('error', (error: Error) => {
      settle({ status: 'error', error: error.message, answer });
    });
  });
}

function abortPiSession(sessionId: string): boolean {
  const process = activePiProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one. A pending entry
  // has no child to signal — flagging it is the whole contract, since the
  // spawn path checks the flag once model resolution settles.
  process.aborted = true;
  process.kill?.('SIGTERM');
  activePiProcesses.delete(sessionId);
  return true;
}

function isPiSessionActive(sessionId: string): boolean {
  return activePiProcesses.has(sessionId);
}

function getActivePiSessions(): string[] {
  return Array.from(activePiProcesses.keys());
}

export const piRuntime = {
  run: spawnPi,
  abort: abortPiSession,
  askSideQuestion: askPiSideQuestion,
};

export {
  spawnPi,
  abortPiSession,
  isPiSessionActive,
  getActivePiSessions,
};
