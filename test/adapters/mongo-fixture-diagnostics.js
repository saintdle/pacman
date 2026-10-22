import { spawnSync } from 'node:child_process';

const outputLimit = 12 * 1024;
const commandTimeoutMs = 5_000;

function tail(value) {
  return String(value ?? '').slice(-outputLimit);
}

function runDocker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: commandTimeoutMs,
    maxBuffer: 64 * 1024,
  });

  return {
    status: result.status,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    error: result.error?.message,
  };
}

function outputOf(result) {
  return [result.stdout, result.stderr, result.error].filter(Boolean).join('\n');
}

function safeWrite(write, message) {
  try {
    write(message);
  } catch {
    // Diagnostic output must not mask the startup failure being reported.
  }
}

function safeRun(runCommand, args) {
  try {
    return runCommand(args) ?? { status: null, error: 'Docker command returned no result' };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function captureMongoStartupFailure({
  containerName,
  error,
  capturedOutput = '',
  cleanupOnFailure = false,
  runCommand = runDocker,
  write = (message) => console.error(message),
}) {
  const errorText = error instanceof Error ? error.stack ?? error.message : String(error);
  safeWrite(write, `[mongo-fixture] Startup failed for ${containerName}: ${tail(errorText)}`);

  const inspect = safeRun(runCommand, ['inspect', '--format', '{{json .State}}', containerName]);
  safeWrite(write, `[mongo-fixture] Container exit/status: ${tail(outputOf(inspect)) || 'unavailable'}`);

  const logs = safeRun(runCommand, ['logs', '--timestamps', '--tail', '100', containerName]);
  safeWrite(write, `[mongo-fixture] Container stdout/stderr (last 100 lines): ${tail(outputOf(logs)) || 'unavailable'}`);

  if (capturedOutput) {
    safeWrite(write, `[mongo-fixture] Captured startup output: ${tail(capturedOutput)}`);
  }

  if (cleanupOnFailure && inspect.status === 0) {
    const cleanup = safeRun(runCommand, ['rm', '-f', containerName]);
    if (cleanup.status !== 0) {
      safeWrite(write, `[mongo-fixture] Failed to remove startup container: ${tail(outputOf(cleanup)) || 'unknown Docker error'}`);
    }
  }
}

export async function runMongoStartupWithDiagnostics({
  containerName,
  startContainer,
  initialize,
  onContainer = () => {},
  runCommand = runDocker,
  write = (message) => console.error(message),
}) {
  let container;
  let capturedOutput = '';
  const captureOutput = (chunk) => {
    capturedOutput = appendMongoStartupOutput(capturedOutput, chunk);
  };

  try {
    container = await startContainer(captureOutput);
    onContainer(container);
    await initialize(container);
    return container;
  } catch (error) {
    captureMongoStartupFailure({
      containerName,
      error,
      capturedOutput,
      cleanupOnFailure: !container,
      runCommand,
      write,
    });
    throw error;
  }
}

export function appendMongoStartupOutput(current, chunk) {
  return tail(`${current}${chunk}`);
}
