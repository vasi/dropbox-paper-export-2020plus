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

export default class Exporter {
  #dbx: Dropbox;
  #output: string;
  #verbose: boolean = false;
  #formats: string[] = Object.keys(Formats);

  #inputState: State;
  #outputState: State;
  #limiter: Limiter;

  #list?: files.ListFolderResult;

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
    const file = path.resolve(output, 'state.json');
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
  }

  #log(...params: any[]) {
    if (this.#verbose) {
      console.log(...params);
    }
  }

  async * #listPaperDocs(): AsyncGenerator<files.FileMetadataReference> {
    this.#log('Starting list...');
    this.#list = await this.#limiter.runHi(() =>
      this.#dbx.filesListFolder({ path: "", recursive: true, limit: 1000 }));
    while (true) {
      for (let entry of this.#list.entries) {
        if (Exporter.looksLikePaper(entry)) {
          yield (entry as files.FileMetadataReference);
        }
      }

      if (!this.#list.has_more) {
        break;
      }
      this.#list = await this.#limiter.runHi(() =>
        this.#dbx.filesListFolderContinue({ cursor: this.#list!.cursor }));
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

    const file = path.resolve(this.#output, relative);
    const dir = path.dirname(file);

    for (let ext of this.#formats) {
      const format = Formats[ext];
      this.#limiter.run(async () => {
        const response = await this.#dbx.filesExport({ path: doc.id, export_format: format });
        this.#log("Exporting", relative, "as", format);

        const contents = response.result.fileBinary.toString();
        const hash = Exporter.#hash(contents);
        docState.hashes[format] = hash;

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file + '.' + ext, response.result.fileBinary);
        return response;
      });
    }
  }

  #writeState() {
    this.#outputState.cursor = this.#list?.cursor;
    let stateFile = path.resolve(this.#output, 'state.json');
    fs.mkdirSync(this.#output, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(this.#outputState, null, 2));
  }

  async run() {
    for await (let doc of this.#listPaperDocs()) {
      this.#exportDoc(doc);
    }
    await this.#limiter.wait();
    this.#writeState();
  }
}
