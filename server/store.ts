import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobSnapshot, ProjectWorkspace } from '../shared/types.js';

interface PersistedState {
  version: 1;
  workspaces: ProjectWorkspace[];
  jobs: JobSnapshot[];
  jobRequests: JobRequestReceipt[];
  sourceTexts: Record<string, string>;
  sourceFiles: Record<string, string>;
}

interface JobRequestReceipt {
  scope: string;
  key: string;
  fingerprint: string;
  job_id: string;
  created_at: string;
}

export type JobCreationResult =
  | { outcome: 'created' | 'replayed'; job: JobSnapshot }
  | { outcome: 'conflict'; reason: 'idempotency_key_reused' | 'job_already_running' | 'receipt_expired'; active_job_id?: string };

const initialState = (): PersistedState => ({ version: 1, workspaces: [], jobs: [], jobRequests: [], sourceTexts: {}, sourceFiles: {} });

export function resolveDataDirectory() {
  const configured = process.env.TC_GIGAHACK_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'TeamCreator', 'gigahack-mvp');
}

export class JsonStore {
  readonly dataDirectory: string;
  private state: PersistedState = initialState();
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory = resolveDataDirectory()) {
    this.dataDirectory = dataDirectory;
  }

  async initialize() {
    if (!this.loaded) {
      this.loaded = (async () => {
        await mkdir(this.dataDirectory, { recursive: true });
        const stateFile = path.join(this.dataDirectory, 'workspace.json');
        try {
          const value = JSON.parse(await readFile(stateFile, 'utf8')) as PersistedState;
          if (value?.version !== 1 || !Array.isArray(value.workspaces)) throw new Error('Unsupported local data format.');
          this.state = {
            ...initialState(),
            ...value,
            jobs: Array.isArray(value.jobs) ? value.jobs : [],
            jobRequests: Array.isArray((value as PersistedState).jobRequests) ? (value as PersistedState).jobRequests : [],
          };
          let interrupted = false;
          for (const job of this.state.jobs) {
            if (job.status !== 'queued' && job.status !== 'running') continue;
            job.status = 'failed';
            job.phase = 'Interrupted by local server restart';
            job.progress = 100;
            job.error = 'The local server restarted during processing. Saved sources are preserved; retry extraction from the Sources view.';
            job.updated_at = new Date().toISOString();
            interrupted = true;
          }
          if (interrupted) await this.persist(this.state);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await this.persist(this.state);
        }
      })();
    }
    await this.loaded;
  }

  async listWorkspaces() {
    await this.initialize();
    return structuredClone(this.state.workspaces);
  }

  async getWorkspace(projectId: string) {
    await this.initialize();
    const workspace = this.state.workspaces.find((entry) => entry.project.id === projectId);
    return workspace ? structuredClone(workspace) : undefined;
  }

  async getSourceText(sourceId: string) {
    await this.initialize();
    try {
      return await readFile(this.resolveTextPath(sourceId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.state.sourceTexts[sourceId];
    }
  }

  async saveSourceText(sourceId: string, text: string) {
    await this.initialize();
    const destination = this.resolveTextPath(sourceId);
    await mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, destination);
  }

  async getSourceFile(sourceId: string) {
    await this.initialize();
    const relative = this.state.sourceFiles[sourceId];
    if (!relative) return undefined;
    const target = path.resolve(this.dataDirectory, relative);
    const fromRoot = path.relative(this.dataDirectory, target);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return undefined;
    try { return await readFile(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async listJobs() {
    await this.initialize();
    return structuredClone(this.state.jobs);
  }

  async getJob(jobId: string) {
    await this.initialize();
    const job = this.state.jobs.find((entry) => entry.id === jobId);
    return job ? structuredClone(job) : undefined;
  }

  async saveJob(job: JobSnapshot) {
    return this.transact((draft) => {
      const index = draft.jobs.findIndex((entry) => entry.id === job.id);
      if (index >= 0) draft.jobs[index] = structuredClone(job);
      else draft.jobs.unshift(structuredClone(job));
      draft.jobs = draft.jobs.slice(0, 80);
    });
  }

  async createJob(job: JobSnapshot, request: Omit<JobRequestReceipt, 'job_id' | 'created_at'>): Promise<JobCreationResult> {
    return this.transact((draft) => {
      const previous = draft.jobRequests.find((entry) => entry.scope === request.scope && entry.key === request.key);
      if (previous) {
        if (previous.fingerprint !== request.fingerprint) return { outcome: 'conflict', reason: 'idempotency_key_reused' };
        const existing = draft.jobs.find((entry) => entry.id === previous.job_id);
        return existing
          ? { outcome: 'replayed', job: structuredClone(existing) }
          : { outcome: 'conflict', reason: 'receipt_expired' };
      }

      const active = draft.jobs.find((entry) => entry.project_id === job.project_id && ['queued', 'running'].includes(entry.status));
      if (active) return { outcome: 'conflict', reason: 'job_already_running', active_job_id: active.id };

      draft.jobs.unshift(structuredClone(job));
      draft.jobs = draft.jobs.slice(0, 80);
      draft.jobRequests.push({ ...request, job_id: job.id, created_at: new Date().toISOString() });
      draft.jobRequests = draft.jobRequests.slice(-2_000);
      return { outcome: 'created', job: structuredClone(job) };
    });
  }

  async transact<T>(change: (draft: PersistedState) => T | Promise<T>): Promise<T> {
    await this.initialize();
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      await this.persist(draft);
      this.state = draft;
      return result;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async saveSourceFile(projectId: string, sourceId: string, name: string, bytes: Buffer) {
    await this.initialize();
    const projectDir = path.resolve(this.dataDirectory, projectId, 'sources');
    const safeName = path.basename(name).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-120) || 'source.bin';
    const destination = path.resolve(projectDir, `${sourceId}-${safeName}`);
    const relative = path.relative(this.dataDirectory, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid source destination.');
    await mkdir(projectDir, { recursive: true });
    const temp = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, destination);
    return path.relative(this.dataDirectory, destination);
  }

  private resolveTextPath(sourceId: string) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(sourceId)) throw new Error('Invalid source ID.');
    const root = path.resolve(this.dataDirectory, 'extracted-text');
    const destination = path.resolve(root, `${sourceId}.txt`);
    const relative = path.relative(root, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid extracted-text destination.');
    return destination;
  }

  private async persist(value: PersistedState) {
    await mkdir(this.dataDirectory, { recursive: true });
    const target = path.join(this.dataDirectory, 'workspace.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temp, target);
  }
}
