import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import _ from 'lodash';
import lockfile from 'proper-lockfile';

import { Dropbox, type files } from 'dropbox';

import getDropbox from './login';
import Limiter from './limiter';
import type State from './state';

const Formats: Record<string, string> = {
  "md": "markdown",
  "html": "html",
}

type ListResult = (files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference);

interface ExporterOptions {
  output: string;
  verbose?: boolean;
  clientId?: string;
  redirectPort?: number;
  formats?: string[],
  directory?: string,
  fresh?: boolean,
}

enum ValidationStatus {
  Unvalidated,
  InProgress,
  Validated,
}

interface IDValue {
  rev: string,
  hash?: string,
  full_path?: string,
  status: ValidationStatus,
}

interface PathValue {
  id: string,
  rev: string,
}

interface LockError {
  code: string;
}

const tempName = '.tmp';
const stateName = "state.json";
const lockName = 'export.lock';

export default class Exporter {
  #dbx: Dropbox;
  #output: string;
  #verbose: boolean = false;

  #directory?: string;
  #formats: string[] = [];

  #pathMap: Map<string, PathValue> = new Map(); // keyed by relative path
  #idMap: Map<string, IDValue> = new Map();

  #limiter: Limiter;
  #tmpdir: string;
  #stateFile: string;
  #cursor?: string;

  static #readState(output: string): State {
    const file = path.join(output, stateName);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      return { docs: {} }
    }
  }

  static async #create(opts: ExporterOptions): Promise<Exporter> {
    if (opts.verbose) {
      console.log("Reading state...");
    }
    const inputState = Exporter.#readState(opts.output);
    const dbx = await getDropbox({
      refreshToken: inputState.refreshToken,
      clientId: opts.clientId,
      redirectPort: opts.redirectPort,
    });
    return Promise.resolve(new Exporter(dbx, inputState, opts));
  }

  static async run(opts: ExporterOptions) {
    if (!fs.existsSync(opts.output))
      fs.mkdirSync(opts.output);
    const lockOpts = { lockfilePath: path.join(opts.output, lockName) };
    let release = undefined;
    try {
      release = await lockfile.lock(opts.output, lockOpts);
      const exporter = await Exporter.#create(opts);
      await exporter.#run();
    } catch (e) {
      const lockError = e as LockError;
      if (lockError.code === 'ELOCKED') {
        throw new Error("Export is already running in this directory");
      } else {
        throw e;
      }
    } finally {
      if (release)
        release();
    }
  }

  static #hash(data: string): string {
    return crypto.createHash('sha3-512').update(data).digest('base64');
  }

  static #relative(path: string): string {
    return path.replace(/^\//g, '');
  }

  static #idMapKey(id: string, ext: string): string {
    return `${id}.${ext}`;
  }

  static #validateFormats(formats: string[]): void {
    for (const format of formats) {
      if (!(format in Formats)) {
        throw new Error(`Unknown format: ${format}`);
      }
    }
  }

  #validateArgs(state: State, opts: ExporterOptions): void {
    if (!opts.fresh && state.args) {
      if (opts.formats && !_.isEqual(opts.formats, state.args.formats))
        throw new Error("Cannot change formats after initial run");
      this.#formats = state.args.formats;
      if (opts.directory && opts.directory !== state.args.directory)
        throw new Error("Cannot change directory after initial run");
      this.#directory = state.args.directory;
    }

    this.#formats = opts.formats ?? Object.keys(Formats);
    this.#directory = opts.directory ?? "";
    Exporter.#validateFormats(this.#formats);
  }

  private constructor(dbx: Dropbox, inputState: State, opts: ExporterOptions) {
    this.#validateArgs(inputState, opts);
    if (opts.fresh) {
      inputState = { docs: {} };
    } else {
      this.#cursor = inputState.cursor;
    }

    this.#dbx = dbx;
    this.#output = opts.output;
    this.#verbose = opts.verbose || false;
    this.#limiter = new Limiter();
    this.#stateFile = path.join(this.#output, stateName);

    this.#tmpdir = path.join(this.#output, tempName);
    fs.rmSync(this.#tmpdir, { force: true, recursive: true });
    fs.mkdirSync(this.#tmpdir, { recursive: true });

    this.#stageInitialize(inputState);
  }

  #log(...params: unknown[]) {
    if (this.#verbose) {
      console.log(...params);
    }
  }

  #removePrefix(str: string): string {
    if (!this.#directory)
      return str;

    const prefix = `${this.#directory}/`;
    if (str.startsWith(prefix)) {
      return str.slice(prefix.length);
    }
    return str;
  }

  #output_for(fpath: string, ext: string): string {
    fpath = this.#removePrefix(Exporter.#relative(fpath));
    return path.join(this.#output, `${fpath}.${ext}`);
  }

  #tmp_for(id: string, ext: string): string {
    return path.join(this.#tmpdir, `${id}.${ext}`);
  }

  #stageInitialize(inputState: State) {
    for (const [id, docState] of Object.entries(inputState.docs ?? {})) {
      if (this.#cursor) { // if no cursor, we start with empty state
        this.#pathMap.set(docState.path, { id, rev: docState.rev });
      }
      for (const ext of this.#formats) {
        const key = Exporter.#idMapKey(id, ext);
        const full_path = this.#output_for(docState.path, ext);
        this.#idMap.set(key, {
          rev: docState.rev,
          hash: docState.hashes[ext],
          full_path,
          status: ValidationStatus.Unvalidated,
        })
      }
    }
  }

  async #initialList(): Promise<files.ListFolderResult> {
    if (this.#cursor) {
      return await this.#limiter.runHi(() =>
        this.#dbx.filesListFolderContinue({ cursor: this.#cursor! }));
    } else {
      const path = this.#directory ? `/${this.#directory}` : "";
      return await this.#limiter.runHi(() =>
        this.#dbx.filesListFolder({ path: path, recursive: true, limit: 1000 }));
    }
  }

  private static looksLikePaper(entry: ListResult): boolean {
    // private instead of '#' for testability
    if (entry['.tag'] != 'file') {
      return false;
    }
    if (entry.is_downloadable) {
      return false;
    }
    if (!(entry.name.endsWith('.paper') || entry.name.endsWith('.papert'))) {
      return false;
    }
    if (!entry.export_info?.export_options?.includes('markdown')) {
      return false;
    }
    return true;
  }

  async #stageList() {
    let list = await this.#initialList();
    this.#cursor = list.cursor;
    while (true) {
      for (const entry of list.entries) {
        const fpath = Exporter.#relative(entry.path_display!);
        if (Exporter.looksLikePaper(entry)) {
          const doc = entry as files.FileMetadataReference;
          this.#pathMap.set(fpath, { id: doc.id, rev: doc.rev })
        } else if (entry['.tag'] == 'deleted') {
          this.#pathMap.delete(fpath);
        }
      }

      if (!list.has_more) {
        break;
      }
      list = await this.#limiter.runHi(() =>
        this.#dbx.filesListFolderContinue({ cursor: this.#cursor! }));
      this.#cursor = list.cursor;
    }
  }

  #fetchIfNeeded(path: string, pathVal: PathValue, ext: string) {
    const idKey = Exporter.#idMapKey(pathVal.id, ext);
    let idVal = this.#idMap.get(idKey);
    if (idVal) {
      if (idVal.status !== ValidationStatus.Unvalidated)
        return; // already handled by someone else

      if (idVal.rev == pathVal.rev && idVal.full_path && fs.existsSync(idVal.full_path)) {
        // maybe we already have it?
        const actualHash = Exporter.#hash(fs.readFileSync(idVal.full_path).toString());
        if (actualHash == idVal.hash) {
          idVal.status = ValidationStatus.Validated;
          return;
        }
      }
      idVal.status = ValidationStatus.InProgress;
    }

    idVal = { rev: pathVal.rev, status: ValidationStatus.InProgress };
    this.#idMap.set(idKey, idVal);

    const api_format = Formats[ext];
    this.#limiter.run(async () => {
      const response = await this.#dbx.filesExport({ path: pathVal.id, export_format: api_format });
      this.#log("Exporting", path, "as", ext);

      const contents = response.result.fileBinary.toString();
      const out = this.#tmp_for(pathVal.id, ext);
      fs.writeFileSync(out, response.result.fileBinary);

      idVal.hash = Exporter.#hash(contents);
      idVal.status = ValidationStatus.Validated;
      idVal.full_path = out;

      return response;
    });
  }

  async #stageFetch() {
    for (const [path, pathVal] of this.#pathMap) {
      for (const ext of this.#formats) {
        this.#fetchIfNeeded(path, pathVal, ext);
      }
    }
    await this.#limiter.wait();
  }

  #writeStateFile() {
    const state: State = {
      refreshToken: this.#dbx.auth.getRefreshToken(),
      cursor: this.#cursor,
      docs: {},
      args: {
        formats: this.#formats,
        directory: this.#directory,
      }
    };
    for (const [path, pathVal] of this.#pathMap) {
      for (const ext of this.#formats) {
        const idKey = Exporter.#idMapKey(pathVal.id, ext);
        const idVal = this.#idMap.get(idKey)!;

        const stateVal = state.docs[pathVal.id] ??= { rev: pathVal.rev, path: path, hashes: {} };
        stateVal.hashes[ext] = idVal.hash!;
      }
    }

    fs.writeFileSync(this.#stateFile, JSON.stringify(state, null, 2));
  }

  #stageEmplace() {
    // Check which paths are correct and don't need to be moved
    const correctPaths = new Set<string>();
    for (const [path, pathVal] of this.#pathMap) {
      for (const ext of this.#formats) {
        const idKey = Exporter.#idMapKey(pathVal.id, ext);
        const idVal = this.#idMap.get(idKey)!;
        if (idVal.full_path === this.#output_for(path, ext)) {
          correctPaths.add(idKey);
        } else if (idVal.full_path!.startsWith(this.#tmpdir)) {
          // Don't need to copy, but also not correct final path
        } else {
          // Make sure it's safe from being overwritten
          const tmp = this.#tmp_for(pathVal.id, ext);
          fs.copyFileSync(idVal.full_path!, tmp);
          idVal.full_path = tmp;
        }
      }
    }

    // Emplace other paths
    for (const [fpath, pathVal] of this.#pathMap) {
      for (const ext of this.#formats) {
        const idKey = Exporter.#idMapKey(pathVal.id, ext);
        if (correctPaths.has(idKey))
          continue;

        const idVal = this.#idMap.get(idKey)!;
        const out = this.#output_for(fpath, ext);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(idVal.full_path!, out);
      }
    }

    this.#writeStateFile();
  }

  #stageCleanup() {
    const toKeep = new Set<string>();
    toKeep.add(stateName);
    toKeep.add(lockName);

    // Figure out what to keep
    for (const rpath of this.#pathMap.keys()) {
      for (const ext of this.#formats) {
        let fpath = this.#removePrefix(`${rpath}.${ext}`);
        while (fpath != '.') {
          toKeep.add(fpath);
          fpath = path.dirname(fpath);
        }
      }
    }

    const files = fs.readdirSync(this.#output, { recursive: true }) as string[];
    for (const file of files) {
      if (!toKeep.has(file)) {
        const abs = path.join(this.#output, file);
        fs.rmSync(abs, { force: true, recursive: true });
      }
    }
  }

  async #run() {
    this.#log("Listing files...");
    await this.#stageList();
    await this.#stageFetch();
    this.#log("Emplacing files and cleaning up");
    this.#stageEmplace();
    this.#stageCleanup();
  }
}
