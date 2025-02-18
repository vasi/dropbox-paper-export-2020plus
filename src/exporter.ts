import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { Dropbox, type files } from 'dropbox';

import getDropbox from './login';
import Limiter from './limiter';
import { type DocState, type State } from './state';

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
}

const tempName = '.tmp';
const stateName = "state.json";

export default class Exporter {
  #dbx: Dropbox;
  #output: string;
  #verbose: boolean = false;
  #formats: string[] = Object.keys(Formats);

  #inputState: State;
  #outputState: State;
  #limiter: Limiter;
  #tmp: string;
  #stateFile: string;

  #cursor?: string;

  static async create(opts: ExporterOptions): Promise<Exporter> {
    const inputState = Exporter.#readState(opts.output);
    const dbx = await getDropbox({
      refreshToken: inputState.refreshToken,
      clientId: opts.clientId,
      redirectPort: opts.redirectPort,
    });
    return Promise.resolve(new Exporter(dbx, inputState, opts));
  }

  static #readState(output: string): State {
    const file = path.join(output, stateName);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      return { docs: {} }
    }
  }

  static #hash(data: string): string {
    return crypto.createHash('sha3-512').update(data).digest('base64');
  }

  private constructor(dbx: Dropbox, inputState: State, opts: ExporterOptions) {
    this.#dbx = dbx;
    this.#inputState = inputState;

    this.#output = opts.output;
    this.#verbose = opts.verbose || false;

    // Validate formats
    this.#formats = opts.formats ?? Object.keys(Formats);
    for (let format of this.#formats) {
      if (!(format in Formats)) {
        throw new Error(`Unknown format: ${format}`);
      }
    }

    this.#limiter = new Limiter();
    this.#outputState = { refreshToken: dbx.auth.getRefreshToken(), docs: {} };

    this.#tmp = path.join(this.#output, tempName);
    fs.rmSync(this.#tmp, { force: true, recursive: true });
    fs.mkdirSync(this.#tmp, { recursive: true });
    this.#stateFile = path.join(this.#output, stateName);
  }

  #log(...params: any[]) {
    if (this.#verbose) {
      console.log(...params);
    }
  }

  async #listAndDispatch() {
    this.#log('Starting list...');
    let list = await this.#limiter.runHi(() =>
      this.#dbx.filesListFolder({ path: "", recursive: true, limit: 1000 }));
    this.#cursor = list.cursor;
    while (true) {
      for (let entry of list.entries) {
        if (Exporter.looksLikePaper(entry)) {
          this.#exportDoc(entry as files.FileMetadataReference);
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

  #exportDoc(doc: files.FileMetadataReference) {
    const relative: string = doc.path_display!.replace(/^\//g, '');
    const docState: DocState = { path: relative, rev: doc.rev, hashes: {} };
    this.#outputState.docs[doc.id] = docState;

    for (let ext of this.#formats) {
      const out = path.join(this.#tmp, doc.id + '.' + ext);
      this.#exportTo(doc, docState, ext, out);
    }
  }

  // Return true if we did use an existing file
  #tryExistingFile(doc: files.FileMetadataReference, docState: DocState, ext: string, out: string): boolean {
    const have = this.#inputState.docs[doc.id];
    if (!have || have.rev !== doc.rev) {
      return false;
    }

    const file = path.join(this.#output, have.path + '.' + ext);
    if (!fs.existsSync(file)) {
      return false;
    }

    const contents = fs.readFileSync(file).toString();
    const hash = Exporter.#hash(contents);
    if (have.hashes[ext] !== hash) {
      return false;
    }

    docState.hashes[ext] = hash;
    fs.copyFileSync(file, out);
    return true;
  }

  #exportTo(doc: files.FileMetadataReference, docState: DocState, ext: string, out: string) {
    // Maybe we already have the file?
    if (this.#tryExistingFile(doc, docState, ext, out)) {
      return;
    }

    const format = Formats[ext];
    this.#limiter.run(async () => {
      const response = await this.#dbx.filesExport({ path: doc.id, export_format: format });
      this.#log("Exporting", docState.path, "as", format);

      const contents = response.result.fileBinary.toString();
      const hash = Exporter.#hash(contents);
      docState.hashes[ext] = hash;
      fs.writeFileSync(out, response.result.fileBinary);
      return response;
    });
  }

  // Return valid paths
  #emplaceDocs(): Set<string> {
    const validDocs = new Set<string>();
    validDocs.add(stateName);

    for (let [id, doc] of Object.entries(this.#outputState.docs)) {
      for (let ext of this.#formats) {
        const source = path.join(this.#tmp, id + '.' + ext);
        const file = doc.path + '.' + ext;

        // Add doc and all parents as valid paths
        validDocs.add(file);
        let valid = file;
        while (true) {
          valid = path.dirname(valid);
          if (valid === '.')
            break;
          validDocs.add(valid);
        }

        const dest = path.join(this.#output, file);
        const destDir = path.dirname(dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(source, dest);
      }
    }
    return validDocs;
  }

  #cleanup(valid: Set<string>) {
    const files = fs.readdirSync(this.#output, { recursive: true }) as string[];
    for (let file of files) {
      if (!valid.has(file)) {
        const abs = path.join(this.#output, file);
        fs.rmSync(abs, { force: true, recursive: true });
      }
    }
  }

  #writeState() {
    this.#outputState.cursor = this.#cursor;
    fs.mkdirSync(this.#output, { recursive: true });
    fs.writeFileSync(this.#stateFile, JSON.stringify(this.#outputState, null, 2));
  }

  async run() {
    await this.#listAndDispatch();
    await this.#limiter.wait();
    this.#log("Emplacing files and cleaning up");
    const valid = this.#emplaceDocs();
    this.#writeState();
    this.#cleanup(valid);
  }
}
