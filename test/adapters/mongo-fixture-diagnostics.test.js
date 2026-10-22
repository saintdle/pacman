import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMongoStartupOutput,
  captureMongoStartupFailure,
  runMongoStartupWithDiagnostics,
} from './mongo-fixture-diagnostics.js';

test('Mongo startup diagnostics capture bounded Docker state and logs before cleanup', () => {
  const commands = [];
  const messages = [];
  const name = 'pacman-mongo-adapter-test';

  captureMongoStartupFailure({
    containerName: name,
    error: new Error('container stopped during startup'),
    capturedOutput: 'mongod initialization output',
    cleanupOnFailure: true,
    runCommand: (args) => {
      commands.push(args);
      if (args[0] === 'inspect') return { status: 0, stdout: '{"Status":"exited","ExitCode":137}' };
      if (args[0] === 'logs') return { status: 0, stdout: 'mongod exited with code 137' };
      return { status: 0, stdout: name };
    },
    write: (message) => messages.push(message),
  });

  assert.deepEqual(commands, [
    ['inspect', '--format', '{{json .State}}', name],
    ['logs', '--timestamps', '--tail', '100', name],
    ['rm', '-f', name],
  ]);
  assert.ok(messages.some((message) => message.includes('ExitCode')));
  assert.ok(messages.some((message) => message.includes('mongod exited with code 137')));
  assert.ok(messages.some((message) => message.includes('mongod initialization output')));
  assert.ok(messages.every((message) => message.length <= 12 * 1024 + 128));
});

test('Mongo startup diagnostics attempt cleanup after inspect failure without masking the startup error', async () => {
  const startupError = new Error('original startup error');
  const commands = [];
  const messages = [];

  await assert.rejects(
    runMongoStartupWithDiagnostics({
      containerName: 'pacman-mongo-adapter-test',
      startContainer: async () => {
        throw startupError;
      },
      initialize: async () => assert.fail('initialize must not run after startup rejection'),
      runCommand: (args) => {
        commands.push(args);
        if (args[0] === 'inspect') return { status: 1, stderr: 'inspect failed' };
        if (args[0] === 'rm') return { status: 1, stderr: 'remove failed' };
        return { status: 0, stdout: 'logs captured' };
      },
      write: (message) => {
        messages.push(message);
        if (message.includes('Failed to remove startup container')) {
          throw new Error('diagnostic reporter failed');
        }
      },
    }),
    (error) => error === startupError,
  );

  assert.deepEqual(commands, [
    ['inspect', '--format', '{{json .State}}', 'pacman-mongo-adapter-test'],
    ['logs', '--timestamps', '--tail', '100', 'pacman-mongo-adapter-test'],
    ['rm', '-f', 'pacman-mongo-adapter-test'],
  ]);
  assert.ok(messages.some((message) => message.includes('Failed to remove startup container')));
});

test('Mongo startup output retains only its bounded tail', () => {
  const output = appendMongoStartupOutput('x'.repeat(12 * 1024 - 3), 'abcdef');
  assert.equal(output.length, 12 * 1024);
  assert.equal(output.slice(-6), 'abcdef');
});

test('Mongo startup diagnostics preserve the original error if the reporter fails', async () => {
  const startupError = new Error('original startup error');

  await assert.rejects(
    runMongoStartupWithDiagnostics({
      containerName: 'pacman-mongo-adapter-test',
      startContainer: async () => {
        throw startupError;
      },
      initialize: async () => assert.fail('initialize must not run after startup rejection'),
      runCommand: () => ({ status: 0, stdout: '{"Status":"exited","ExitCode":37}' }),
      write: () => {
        throw new Error('diagnostic reporter failed');
      },
    }),
    (error) => error === startupError,
  );
});
