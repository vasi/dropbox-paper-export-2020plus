import { Dropbox, DropboxAuth, type DropboxAuthOptions, type DropboxOptions, type files } from 'dropbox';
import path from 'path';
import fs from 'fs';
import getDropbox from './login';

import Limiter from './limiter';
import type State from './state';

type ListResult = (files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference);

interface ExporterOptions {
  output: string;
  verbose?: boolean;
}

export default class Exporter {
  #dbx: Dropbox;
  #output: string;
  #limiter: Limiter;
  #verbose: boolean = false;
  #state: State;

  #list?: files.ListFolderResult;

  static async create(opts: ExporterOptions): Promise<Exporter> {
    const state = Exporter.#readState(opts.output);
    const dbx = await getDropbox(state.refreshToken);
    state.refreshToken = dbx.auth.getRefreshToken();
    return Promise.resolve(new Exporter(dbx, state, opts));
  }

  static #readState(output: string): State {
    const file = path.resolve(output, 'state.json');
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      return { docs: new Map() }
    }
  }

  private constructor(dbx: Dropbox, state: State, opts: ExporterOptions) {
    this.#dbx = dbx;
    this.#state = state;
    this.#output = opts.output;
    this.#verbose = opts.verbose || false;
    this.#limiter = new Limiter();
  }

  #log(...params: any[]) {
    if (this.#verbose) {
      console.log(...params);
    }
  }

  async * #listPaperDocs(): AsyncGenerator<files.FileMetadataReference> {
    this.#log('Starting list...');
    this.#list = await this.#limiter.runHi(() => this.#dbx.filesListFolder({ "path": "", "recursive": true, "limit": 1000 }));
    while (true) {
      for (let entry of this.#list.entries) {
        if (Exporter.looksLikePaper(entry)) {
          yield (entry as files.FileMetadataReference);
        }
      }

      if (!this.#list.has_more) {
        break;
      }
      this.#list = await this.#limiter.runHi(() => this.#dbx.filesListFolderContinue({ "cursor": this.#list!.cursor }));
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
    const formats = {
      'markdown': '.md',
      'html': '.html',
    }

    const relative: string = doc.path_display!.replace(/^\//g, '');
    const file = path.resolve(this.#output, relative);
    const dir = path.dirname(file);

    for (const [format, ext] of Object.entries(formats)) {
      this.#limiter.run(async () => {
        const response = await this.#dbx.filesExport({ path: doc.id, export_format: format });
        this.#log("Exporting", relative, "as", format);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file + ext, response.result.fileBinary);
        return response;
      });
    }
  }

  async run() {
    for await (let doc of this.#listPaperDocs()) {
      this.#exportDoc(doc);
    }
    await this.#limiter.wait();

    let stateFile = path.resolve(this.#output, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(this.#state, null, 2));
  }
}
