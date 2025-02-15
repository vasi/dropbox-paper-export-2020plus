import { Dropbox, DropboxAuth, type DropboxAuthOptions, type DropboxOptions, type files } from 'dropbox';
import path, { resolve } from 'path';
import fs from 'fs';

import Limiter from './limiter';

type ListResult = (files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference);

interface ExporterOptions {
  dbx: Dropbox;
  output: string;
  verbose?: boolean;
}

export default class Exporter {
  #dbx: Dropbox;
  #output: string;
  #limiter: Limiter;
  #verbose: boolean = false;

  #list?: files.ListFolderResult;

  constructor(opts: ExporterOptions) {
    this.#dbx = opts.dbx;
    this.#output = opts.output;
    this.#verbose = opts.verbose || false;
    this.#limiter = new Limiter();
  }

  #log(...params: any[]) {
    if (this.#verbose) {
      console.log(...params);
    }
  }

  async *#listPaperDocs(): AsyncGenerator<files.FileMetadataReference> {
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
    const file = path.join(this.#output, relative);
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
  }
}
