// node:test runs each test file in a child process whose stdout carries the
// v8-serialized result frames back to the runner — with the child's raw
// console output multiplexed onto the same pipe (nodejs/node#64061). Any
// console.* call from code under test can desync the runner's frame parser
// and fail the whole file with "Unable to deserialize cloned data due to
// invalid or unsupported version." NODE_TEST_CONTEXT is set only inside
// those children; there we route console output to stderr, which is not
// part of the frame transport, keeping logs visible and the stream pure.
// Loaded via NODE_OPTIONS in the `test` script so every runner-spawned
// child picks it up.
import { format } from 'node:util';

if (process.env.NODE_TEST_CONTEXT) {
  // Drop our own --import from the environment: tests spawn grandchildren
  // (fake CLIs, bootstrap checks) whose cwd is usually a temp directory,
  // where the relative path fails to resolve and crashes them at startup.
  // The guard is already loaded here; nobody downstream needs it again.
  const ownFlag = '--import=./scripts/test-stdout-guard.mjs';
  if (process.env.NODE_OPTIONS?.includes(ownFlag)) {
    const stripped = process.env.NODE_OPTIONS
      .split(ownFlag)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) {
      process.env.NODE_OPTIONS = stripped;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  }

  const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const wrap = (target) => {
    for (const method of METHODS) {
      if (typeof target[method] === 'function') {
        target[method] = (...args) => {
          process.stderr.write(`${format(...args)}\n`);
        };
      }
    }
    return target;
  };

  // Wrap the current console, and keep wrapping whatever replaces it later:
  // the test child installs its own Console on top of the preloads.
  let current = wrap(globalThis.console);
  Object.defineProperty(globalThis, 'console', {
    configurable: true,
    get: () => current,
    set: (value) => {
      current = wrap(value);
    },
  });
}
