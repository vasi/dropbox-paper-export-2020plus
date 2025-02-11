import { Command } from 'commander';
import { Dropbox, type files } from 'dropbox';
import PQueue from 'p-queue';
import path from 'path';
import fs from 'fs';

type ListResult = (files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference);

async function checkAccount(dbx: Dropbox) {
  await dbx.checkUser({});

  const features = await dbx.rpcRequest("users/features/get_values", { features: ["paper_as_files"] }, 'user', 'api');
  if (!features.result.values[0].paper_as_files.enabled) {
    console.error("Paper as files feature is not enabled for this user");
    process.exit(1);
  }
}

function looksLikePaper(entry: ListResult): boolean {
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

async function* paperDocs(dbx: Dropbox): AsyncGenerator<files.FileMetadataReference> {
  let list = await dbx.filesListFolder({ "path": "", "recursive": true, "limit": 100 });
  while (true) {
    for (let entry of list.result.entries) {
      if (looksLikePaper(entry)) {
        yield (entry as files.FileMetadataReference);
      }
    }

    if (!list.result.has_more) {
      break;
    }
    list = await dbx.filesListFolderContinue({ "cursor": list.result.cursor });
  }
}

async function exportDoc(output: string, dbx: Dropbox, doc: files.FileMetadataReference) {
  const formats = {
    'markdown': '.md',
    'html': '.html',
  }

  const relative: string = doc.path_display!.replace(/^\//g, '');
  console.log("Exporting", relative);
  const file = path.join(output, relative);
  const dir = path.dirname(file);

  fs.mkdirSync(dir, { recursive: true });
  for (const [format, ext] of Object.entries(formats)) {
    const response = await dbx.filesExport({ path: doc.id, export_format: format });
    fs.writeFileSync(file + ext, response.result.fileBinary);
  }
}

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .arguments('<output>')
  .action(async (output, options) => {
    const dbx = new Dropbox({ accessToken: process.env.API_TOKEN });
    await checkAccount(dbx);

    const pq = new PQueue({ concurrency: 32 });
    for await (let doc of paperDocs(dbx)) {
      pq.add(async () => await exportDoc(output, dbx, doc));
    }
    await pq.onIdle();
  });
program.parse(process.argv);
