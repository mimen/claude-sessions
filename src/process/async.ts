export interface AsyncProcessResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface AsyncProcessOptions {
  readonly timeoutMs: number;
  readonly captureOutput?: boolean;
}

export interface AsyncProcessAdapter {
  run(
    file: string,
    args: readonly string[],
    options: AsyncProcessOptions,
  ): Promise<AsyncProcessResult>;
}

const SIGTERM_GRACE_MS = 100;

/** Bun subprocess adapter that never blocks the caller's event loop while a command is in flight. */
export const bunAsyncProcessAdapter: AsyncProcessAdapter = {
  async run(
    file: string,
    args: readonly string[],
    options: AsyncProcessOptions,
  ): Promise<AsyncProcessResult> {
    const captureOutput = options.captureOutput === true;
    let child: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe" | "ignore">;
    try {
      child = Bun.spawn([file, ...args], {
        stdin: "ignore",
        stdout: captureOutput ? "pipe" : "ignore",
        stderr: captureOutput ? "pipe" : "ignore",
      });
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }

    let timedOut = false;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, SIGTERM_GRACE_MS);
    }, options.timeoutMs);

    try {
      const stdoutPromise = captureOutput && child.stdout !== null
        ? new Response(child.stdout).text()
        : Promise.resolve("");
      const stderrPromise = captureOutput && child.stderr !== null
        ? new Response(child.stderr).text()
        : Promise.resolve("");
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        stdoutPromise,
        stderrPromise,
      ]);
      return { ok: exitCode === 0 && !timedOut, stdout, stderr, timedOut };
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut,
      };
    } finally {
      clearTimeout(timeout);
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
    }
  },
};
