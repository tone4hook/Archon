import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import {
  getOrCreateReloadedExtensionLoader,
  resetReloadedExtensionLoaderCache,
} from './resource-loader';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let scratchDir: string | undefined;

afterEach(() => {
  resetReloadedExtensionLoaderCache();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

test("loads native guidance and only the workflow node's declared skill", async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-context-'));
  const agentDir = join(scratchDir, 'agent');
  const projectRoot = join(scratchDir, 'project');
  const cwd = join(projectRoot, 'nested');
  const globalContextPath = join(agentDir, 'AGENTS.md');
  const projectContextPath = join(projectRoot, 'CLAUDE.md');
  const ambientSkillPath = join(agentDir, 'skills', 'ambient-skill');
  const declaredSkillPath = join(scratchDir, 'declared-skill');

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(globalContextPath, '# User rules\n');
  writeFileSync(projectContextPath, '# Project rules\n');
  mkdirSync(ambientSkillPath, { recursive: true });
  mkdirSync(declaredSkillPath, { recursive: true });
  writeFileSync(
    join(ambientSkillPath, 'SKILL.md'),
    '---\nname: ambient-skill\ndescription: must stay hidden\n---\n'
  );
  writeFileSync(
    join(declaredSkillPath, 'SKILL.md'),
    '---\nname: declared-skill\ndescription: selected by the node\n---\n'
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { loader } = await getOrCreateReloadedExtensionLoader(cwd, {
    additionalSkillPaths: [declaredSkillPath],
  });

  expect(loader.getAgentsFiles().agentsFiles).toEqual(
    expect.arrayContaining([
      { path: globalContextPath, content: '# User rules\n' },
      { path: projectContextPath, content: '# Project rules\n' },
    ])
  );
  expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(['declared-skill']);
});

/** Stage an agent dir with one discoverable extension plus a cwd outside it. */
function stageExtensionFixture(): { cwd: string; ambientPath: string } {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-extensions-'));
  const agentDir = join(scratchDir, 'agent');
  const cwd = join(scratchDir, 'project');
  const ambientPath = join(agentDir, 'extensions', 'ambient.ts');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(join(cwd, 'exts'), { recursive: true });
  writeFileSync(ambientPath, 'export default function () {}\n');
  writeFileSync(join(cwd, 'exts', 'declared.ts'), 'export default function () {}\n');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { cwd, ambientPath };
}

test('without an allow-list, Pi discovers installed extensions', async () => {
  const { cwd, ambientPath } = stageExtensionFixture();

  const { loader } = await getOrCreateReloadedExtensionLoader(cwd);

  expect(loader.getExtensions().extensions.map(ext => ext.resolvedPath)).toEqual([ambientPath]);
});

test('an allow-list loads only the listed extension, resolved against cwd', async () => {
  const { cwd } = stageExtensionFixture();

  const { loader } = await getOrCreateReloadedExtensionLoader(cwd, {
    extensionSources: ['./exts/declared.ts'],
  });

  expect(loader.getExtensions().extensions.map(ext => ext.resolvedPath)).toEqual([
    join(cwd, 'exts', 'declared.ts'),
  ]);
});

test('an empty allow-list loads no extensions and gets its own cached loader', async () => {
  const { cwd } = stageExtensionFixture();

  const discovered = await getOrCreateReloadedExtensionLoader(cwd);
  const none = await getOrCreateReloadedExtensionLoader(cwd, { extensionSources: [] });

  expect(none.loader).not.toBe(discovered.loader);
  expect(none.loader.getExtensions().extensions).toEqual([]);
});

test('a missing allow-listed extension fails the load and is not cached', async () => {
  const { cwd } = stageExtensionFixture();
  const options = { extensionSources: ['./exts/missing.ts'] };

  await expect(getOrCreateReloadedExtensionLoader(cwd, options)).rejects.toThrow(
    /Pi extension load failed: .*missing\.ts.*listed in the Pi `extensions` setting/
  );
  writeFileSync(join(cwd, 'exts', 'missing.ts'), 'export default function () {}\n');
  const { loader } = await getOrCreateReloadedExtensionLoader(cwd, options);
  expect(loader.getExtensions().extensions).toHaveLength(1);
});
