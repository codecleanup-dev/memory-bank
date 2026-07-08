import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Save original env
const originalEnv = { ...process.env };

describe('paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-paths-'));
    // Clear all relevant env vars before each test
    delete process.env.MEMORY_BANK_CONFIG_DIR;
    delete process.env.PERSONAL_SUPERPOWERS_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.MEMORY_BANK_DB_PATH;
    delete process.env.TEST_DB_PATH;
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
  });

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getSuperpowersDir', () => {
    it('should use MEMORY_BANK_CONFIG_DIR when set', async () => {
      const configDir = path.join(tmpDir, 'custom-config');
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      // Re-import to get fresh module
      const { getSuperpowersDir } = await import('../src/paths.js');
      const result = getSuperpowersDir();
      expect(result).toBe(configDir);
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it('should use PERSONAL_SUPERPOWERS_DIR as second priority', async () => {
      const personalDir = path.join(tmpDir, 'personal');
      process.env.PERSONAL_SUPERPOWERS_DIR = personalDir;
      const { getSuperpowersDir } = await import('../src/paths.js');
      const result = getSuperpowersDir();
      expect(result).toBe(personalDir);
      expect(fs.existsSync(personalDir)).toBe(true);
    });

    it('should prefer MEMORY_BANK_CONFIG_DIR over PERSONAL_SUPERPOWERS_DIR', async () => {
      const configDir = path.join(tmpDir, 'config');
      const personalDir = path.join(tmpDir, 'personal');
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      process.env.PERSONAL_SUPERPOWERS_DIR = personalDir;
      const { getSuperpowersDir } = await import('../src/paths.js');
      const result = getSuperpowersDir();
      expect(result).toBe(configDir);
    });

    it('should use XDG_CONFIG_HOME/superpowers when set', async () => {
      const xdgDir = path.join(tmpDir, 'xdg');
      process.env.XDG_CONFIG_HOME = xdgDir;
      const { getSuperpowersDir } = await import('../src/paths.js');
      const result = getSuperpowersDir();
      expect(result).toBe(path.join(xdgDir, 'superpowers'));
    });

    it('should default to ~/.config/superpowers', async () => {
      const { getSuperpowersDir } = await import('../src/paths.js');
      const result = getSuperpowersDir();
      expect(result).toBe(path.join(os.homedir(), '.config', 'superpowers'));
    });
  });

  describe('getArchiveDir', () => {
    it('should use TEST_ARCHIVE_DIR when set', async () => {
      const archiveDir = path.join(tmpDir, 'test-archive');
      process.env.TEST_ARCHIVE_DIR = archiveDir;
      const { getArchiveDir } = await import('../src/paths.js');
      const result = getArchiveDir();
      expect(result).toBe(archiveDir);
      expect(fs.existsSync(archiveDir)).toBe(true);
    });

    it('should use superpowers/conversation-archive by default', async () => {
      const configDir = path.join(tmpDir, 'config');
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      const { getArchiveDir } = await import('../src/paths.js');
      const result = getArchiveDir();
      expect(result).toBe(path.join(configDir, 'conversation-archive'));
    });
  });

  describe('getDbPath', () => {
    it('should use MEMORY_BANK_DB_PATH when set', async () => {
      const dbPath = path.join(tmpDir, 'custom.sqlite');
      process.env.MEMORY_BANK_DB_PATH = dbPath;
      const { getDbPath } = await import('../src/paths.js');
      expect(getDbPath()).toBe(dbPath);
    });

    it('should use TEST_DB_PATH as fallback', async () => {
      const dbPath = path.join(tmpDir, 'test.sqlite');
      process.env.TEST_DB_PATH = dbPath;
      const { getDbPath } = await import('../src/paths.js');
      expect(getDbPath()).toBe(dbPath);
    });

    it('should prefer MEMORY_BANK_DB_PATH over TEST_DB_PATH', async () => {
      const mainPath = path.join(tmpDir, 'main.sqlite');
      const testPath = path.join(tmpDir, 'test.sqlite');
      process.env.MEMORY_BANK_DB_PATH = mainPath;
      process.env.TEST_DB_PATH = testPath;
      const { getDbPath } = await import('../src/paths.js');
      expect(getDbPath()).toBe(mainPath);
    });
  });

  describe('getExcludedProjects', () => {
    it('should return empty array when no config', async () => {
      process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
      const { getExcludedProjects } = await import('../src/paths.js');
      expect(getExcludedProjects()).toEqual([]);
    });

    it('should parse env var comma-separated list', async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project1, project2, project3';
      const { getExcludedProjects } = await import('../src/paths.js');
      expect(getExcludedProjects()).toEqual(['project1', 'project2', 'project3']);
    });

    it('should read from exclude.txt config file', async () => {
      const configDir = path.join(tmpDir, 'config');
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      // Need to create the index dir structure
      const indexDir = path.join(configDir, 'conversation-index');
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(path.join(indexDir, 'exclude.txt'), '# comment\nproject1\nproject2\n\n# another comment\nproject3\n');
      const { getExcludedProjects } = await import('../src/paths.js');
      expect(getExcludedProjects()).toEqual(['project1', 'project2', 'project3']);
    });

    it('should filter empty strings from env var with consecutive commas', async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project1,,project2, ,project3';
      const { getExcludedProjects } = await import('../src/paths.js');
      expect(getExcludedProjects()).toEqual(['project1', 'project2', 'project3']);
    });

    it('should ignore comments and empty lines in exclude.txt', async () => {
      const configDir = path.join(tmpDir, 'config');
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      const indexDir = path.join(configDir, 'conversation-index');
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(path.join(indexDir, 'exclude.txt'), '#full comment\n\n  \nvalid-project\n');
      const { getExcludedProjects } = await import('../src/paths.js');
      expect(getExcludedProjects()).toEqual(['valid-project']);
    });
  });

  describe('isExcludedProject', () => {
    it('should exclude the current LLM workdir slug (built-in)', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('-private-var-folders-ms-q41xyz-T-memory-bank-llm', [])).toBe(true);
    });

    it('should exclude legacy mkdtemp LLM workdir slugs (built-in)', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('-private-var-folders-ms-q41xyz-T-tmp-03lvGlu1k7-memory-bank-llm', [])).toBe(true);
    });

    it('should exclude the bare workdir basename (built-in)', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('memory-bank-llm', [])).toBe(true);
    });

    it('should not exclude ordinary projects', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('-Users-jung-wankim-Project-Claude-cc-sync', [])).toBe(false);
      // Repo dir itself is not the worker slug
      expect(isExcludedProject('-Users-jung-wankim-Project-Claude-memory-bank', [])).toBe(false);
    });

    it('should not exclude names merely containing the workdir basename mid-slug', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('-Users-x-memory-bank-llm-docs', [])).toBe(false);
    });

    it('should honor the user-configured exact-match list', async () => {
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('some-project', ['some-project'])).toBe(true);
      expect(isExcludedProject('other-project', ['some-project'])).toBe(false);
    });

    it('should fall back to getExcludedProjects when no list is given', async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'env-excluded';
      const { isExcludedProject } = await import('../src/paths.js');
      expect(isExcludedProject('env-excluded')).toBe(true);
      expect(isExcludedProject('env-included')).toBe(false);
    });
  });

  describe('getProjectsDir', () => {
    it('should honor TEST_PROJECTS_DIR override', async () => {
      process.env.TEST_PROJECTS_DIR = tmpDir;
      const { getProjectsDir } = await import('../src/paths.js');
      expect(getProjectsDir()).toBe(tmpDir);
    });

    it('should default to ~/.claude/projects', async () => {
      delete process.env.TEST_PROJECTS_DIR;
      const { getProjectsDir } = await import('../src/paths.js');
      expect(getProjectsDir()).toBe(path.join(os.homedir(), '.claude', 'projects'));
    });
  });
});
