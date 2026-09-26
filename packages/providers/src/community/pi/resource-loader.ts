import { DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

/**
 * In pi-coding-agent <= 0.67.x, DefaultResourceLoader and PackageManager
 * fell back to `getAgentDir()` when `options.agentDir` was undefined. In
 * 0.71.x+, that fallback was removed — callers MUST pass an agentDir or
 * any `join(agentDir, ...)` call throws `TypeError: paths[0] must be of
 * type string, got undefined`. This is the symptom that originally pinned
 * Archon to pi-ai ^0.67.5.
 *
 * Call Pi's own `getAgentDir()` so we honor `PI_CODING_AGENT_DIR` (and any
 * future env-var overrides Pi adds) instead of hardcoding `~/.pi/agent`.
 * This matches the exact behavior of the pre-0.71 fallback.
 */

export interface PiResourceLoaderOptions {
  /**
   * Override Pi's system prompt entirely. When omitted, Pi uses its default.
   * Forwarded to `DefaultResourceLoader({ systemPrompt })`. Pi still appends
   * the context files it discovers through its native project and user rules.
   */
  systemPrompt?: string;

  /**
   * Absolute paths to specific skill directories (each containing a SKILL.md)
   * that Pi should load in addition to its default discovery. Works even with
   * `noSkills: true` — Pi's loader merges additional paths regardless, per
   * its internal logic in `DefaultResourceLoader.updateSkillsFromPaths`.
   *
   * Used by the Pi provider to thread Archon's name-based `skills:` node
   * config through to Pi after resolution — see `resolvePiSkills`.
   */
  additionalSkillPaths?: string[];

  /**
   * Opt-in to Pi's extension discovery. When true, `noExtensions` flips to
   * false and Pi loads:
   *   - `~/.pi/agent/extensions/*.ts` (global, operator-installed)
   *   - packages listed in `~/.pi/agent/settings.json` (from `pi install`)
   *   - `<cwd>/.pi/extensions/*.ts` (project-local — REPO-CONTROLLED, risky)
   *   - packages listed in `<cwd>/.pi/settings.json`
   *
   * This is the switch that opens up the community package ecosystem
   * (https://shittycodingagent.ai/packages) — ~540 npm packages registering
   * custom tools and lifecycle hooks via `pi.registerTool()` / `pi.on()`.
   * Tools and hooks work fully in programmatic sessions; TUI-only features
   * (renderers, keybindings, slash commands) silently no-op. Extensions that
   * gate on `ctx.hasUI` additionally need `interactive: true` — see
   * `PiProviderDefaults.interactive`.
   *
   * Trust boundary: enabling this loads arbitrary JS code with the Archon
   * server's OS permissions. Only flip this on when the operator trusts both
   * globally-installed extensions AND whatever `.pi/` the workflow's target
   * repo happens to contain.
   *
   * @default false
   */
  enableExtensions?: boolean;

  /**
   * Explicit extension allow-list (`pi --no-extensions -e <source>...`).
   * When defined, Pi's extension discovery stays off and only these sources
   * load, resolved by Pi relative to `cwd`. An empty array loads none. Only
   * consulted when `enableExtensions` is true.
   */
  extensionSources?: string[];
}

/**
 * Build the ResourceLoader Archon supplies to Pi. Archon owns explicit skill,
 * prompt-template, and theme delivery, but leaves context-file discovery to
 * Pi. Pi therefore applies its native defaults, including user and project
 * `AGENTS.md` / `CLAUDE.md` files, without an Archon-specific toggle.
 *
 * When `enableExtensions: true`, the `noExtensions` gate is lifted so Pi
 * discovers and loads tools + hooks from the community ecosystem (see
 * `PiResourceLoaderOptions.enableExtensions`), unless `extensionSources`
 * narrows loading to an explicit allow-list. Skills and prompts/themes
 * remain suppressed even when extensions are enabled — skills are still
 * driven by Archon's explicit `additionalSkillPaths` plumbing.
 *
 * Implementation note: we delegate to `DefaultResourceLoader` with the
 * relevant `no*` flags set, rather than implementing `ResourceLoader`
 * ourselves. The interface's `getExtensions()` returns a `LoadExtensionsResult`
 * requiring a real `ExtensionRuntime`, which we can't meaningfully stub.
 * DefaultResourceLoader honors the flags and returns empty-but-valid results.
 */
export function createPiResourceLoader(
  cwd: string,
  options: PiResourceLoaderOptions = {}
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    // Required since pi-coding-agent 0.71 dropped the implicit fallback.
    // Calling Pi's own `getAgentDir()` honors `PI_CODING_AGENT_DIR` and
    // matches the behavior of the pre-0.71 default exactly.
    agentDir: getAgentDir(),
    // An allow-list keeps discovery off; Pi still loads additionalExtensionPaths
    // when noExtensions is true, exactly as `pi --no-extensions -e` does.
    noExtensions: options.enableExtensions !== true || options.extensionSources !== undefined,
    ...(options.enableExtensions === true && options.extensionSources !== undefined
      ? { additionalExtensionPaths: options.extensionSources }
      : {}),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.additionalSkillPaths && options.additionalSkillPaths.length > 0
      ? { additionalSkillPaths: options.additionalSkillPaths }
      : {}),
  });
}

/**
 * Process-level cache of reloaded, extension-bearing ResourceLoaders (issue #1877).
 *
 * Pi's `DefaultResourceLoader.reload()` re-runs the entire extension-discovery
 * pipeline — `packageManager.resolve()` + `loadExtensions()` — and
 * `loadExtensions()` re-invokes every installed extension's factory from scratch
 * (jiti is created with `moduleCache: false`). Those factories can construct
 * process-scoped singletons (ports, file handles, nested SDK clients) in their
 * setup or `session_start` handler. That state is never torn down between Archon
 * `sendQuery()` calls: Archon disposes sessions via `session.dispose()`, which —
 * unlike `session.reload()` — does NOT emit `session_shutdown`. So the SECOND
 * `reload()` in a process deadlocks colliding with the first call's still-live
 * state, and every Pi workflow node after the first idle-times-out.
 *
 * Fix: reload the extension-bearing loader ONCE per process per loader-affecting
 * input set and reuse it. `createAgentSession({ resourceLoader })` skips its own
 * internal `reload()` when a loader is supplied, and reads the already-loaded
 * extensions via `resourceLoader.getExtensions()` — so reuse is safe. Each
 * session still builds its own ExtensionRunner and fires `session_start` via
 * `bindExtensions()`, preserving per-node behavior.
 *
 * Growth & eviction: entries are keyed by `(cwd, systemPrompt, skillPaths)`, so
 * the cache grows by at most one small loader per distinct worktree/prompt combo
 * the process ever runs with extensions on — bounded in practice by the number of
 * worktrees touched, not by request volume. Eviction is deliberately limited to
 * the failure path (below): size-capped/LRU eviction is NOT safe here because
 * dropping a loader that a long-running workflow is still using would make that
 * workflow's next node cache-miss and `reload()` a second copy of the same
 * extensions while the first is still live — re-introducing the very deadlock
 * this cache prevents. Time/idle-based reclamation belongs with isolation
 * cleanup (a future cross-package hook), not a blind cap here.
 */
const reloadedExtensionLoaderCache = new Map<string, Promise<ReloadedExtensionLoader>>();

/**
 * One extension provider registration captured at load time — the payload an
 * extension factory passed to `pi.registerProvider()` while `reload()` ran.
 * Mirrors the SDK's `ExtensionRuntimeState['pendingProviderRegistrations']`
 * element shape.
 */
export interface ExtensionProviderRegistration {
  name: string;
  config: ProviderConfig;
  extensionPath: string;
}

/**
 * A cached, already-reloaded extension loader plus the provider registrations
 * its extensions queued at load time (issue #2064).
 *
 * Why the snapshot exists: extension factories run only during the single
 * cached `reload()` (see the deadlock note above), and a load-time
 * `pi.registerProvider()` call is QUEUED on the loader's shared extension
 * runtime (`runtime.pendingProviderRegistrations`), not applied. The first
 * session built on this loader drains that queue into ITS ModelRegistry via
 * `bindCore()` and clears it — so the second and later sendQuery calls, which
 * each build a fresh per-call ModelRegistry, would never see extension models
 * (e.g. pi-cursor's `cursor/*`) and fail LOOKUP-2 with "Pi model not found".
 *
 * The snapshot is taken right after `reload()` completes, BEFORE any session
 * can drain the queue (`bindCore()` reassigns the array rather than mutating
 * it, so the copy is stable). The provider re-applies it to every per-call
 * registry — `ModelRegistry.registerProvider()` is a documented upsert, so
 * the first session receiving the same configs twice (our re-apply + its own
 * `bindCore()` flush) is harmless.
 */
export interface ReloadedExtensionLoader {
  loader: DefaultResourceLoader;
  providerRegistrations: readonly ExtensionProviderRegistration[];
}

/**
 * Cache key over every input baked into the loader. `systemPrompt`,
 * `additionalSkillPaths`, and `extensionSources` are included so a per-node
 * override never silently reuses a loader carrying a different prompt or
 * extension set — a distinct input yields a distinct loader (which is reloaded
 * once on its own). `null` (discover everything) and `[]` (load nothing) are
 * different keys. In the common case (uniform inputs across nodes) all nodes
 * share one cached loader.
 */
function extensionLoaderCacheKey(
  cwd: string,
  systemPrompt: string | undefined,
  additionalSkillPaths: readonly string[],
  extensionSources: readonly string[] | undefined
): string {
  return JSON.stringify([
    cwd,
    systemPrompt ?? null,
    [...additionalSkillPaths].sort(),
    // Not sorted: Pi loads extensions in list order, which decides conflicts.
    extensionSources ?? null,
  ]);
}

/**
 * Return a process-cached, already-reloaded extension-bearing ResourceLoader
 * plus the load-time provider registrations its extensions queued (see
 * `ReloadedExtensionLoader`), constructing + `reload()`ing it on first use for
 * a given input set. Always loads with `enableExtensions: true` — this is the
 * only path that runs the non-re-entrant `reload()`, so it is the only path
 * that needs the cache.
 *
 * Concurrency: the cache stores the in-flight Promise (not the resolved entry)
 * so concurrent same-layer nodes await a single shared `reload()` instead of
 * racing into two. A failed reload is evicted so the next call retries cleanly.
 */
export async function getOrCreateReloadedExtensionLoader(
  cwd: string,
  options: Pick<
    PiResourceLoaderOptions,
    'systemPrompt' | 'additionalSkillPaths' | 'extensionSources'
  > = {}
): Promise<ReloadedExtensionLoader> {
  const key = extensionLoaderCacheKey(
    cwd,
    options.systemPrompt,
    options.additionalSkillPaths ?? [],
    options.extensionSources
  );
  let pending = reloadedExtensionLoaderCache.get(key);
  if (!pending) {
    pending = (async (): Promise<ReloadedExtensionLoader> => {
      const loader = createPiResourceLoader(cwd, { ...options, enableExtensions: true });
      // reload() loads the extensions into the loader so createAgentSession can
      // build session.extensionRunner. Without it the runner is undefined and the
      // provider's `if (runner)` flag pass-through is skipped — extensionFlags
      // would silently never apply.
      try {
        await loader.reload();
        // Pi records a broken or missing extension in `errors` and carries on.
        // That is right for discovery, but an allow-listed extension was named
        // on purpose, so running the node without it would silently drop a
        // capability the author asked for.
        const { errors } = loader.getExtensions();
        if (options.extensionSources !== undefined && errors.length > 0) {
          throw new Error(errors.map(({ path, error }) => `${path}: ${error}`).join('; '));
        }
        // Snapshot NOW, before any session's bindCore() drains the queue into
        // its own ModelRegistry and clears it. Defensive copy: bindCore()
        // reassigns the array, so the copy stays stable, but a copy also
        // guards against future in-place mutation upstream.
        const providerRegistrations: ExtensionProviderRegistration[] = [
          ...loader.getExtensions().runtime.pendingProviderRegistrations,
        ];
        return { loader, providerRegistrations };
      } catch (error) {
        // Extensions execute arbitrary JS from ~/.pi/agent/extensions/ (and the
        // repo's .pi/); a broken one fails here. Rethrow with an actionable
        // pointer, preserving the original error as `cause`, so the operator
        // isn't left with a bare Pi SDK message. The failed promise is evicted
        // below, so the next call retries cleanly.
        const message = error instanceof Error ? error.message : String(error);
        const hint =
          options.extensionSources !== undefined
            ? 'Check the paths and sources listed in the Pi `extensions` setting for this node.'
            : "Check the extensions in ~/.pi/agent/extensions/ (and the repo's .pi/), or set " +
              '`assistants.pi.enableExtensions: false` to run without them.';
        throw new Error(`Pi extension load failed: ${message}. ${hint}`, { cause: error });
      }
    })();
    reloadedExtensionLoaderCache.set(key, pending);
    // Evict on failure so a transient reload error doesn't poison the cache.
    pending.catch(() => reloadedExtensionLoaderCache.delete(key));
  }
  return pending;
}

/**
 * Test-only: clear the process-level loader cache so each test starts empty.
 * The cache is module-level and would otherwise leak loaders (and their mocked
 * reload/construct call counts) across tests in the same file.
 */
export function resetReloadedExtensionLoaderCache(): void {
  reloadedExtensionLoaderCache.clear();
}
