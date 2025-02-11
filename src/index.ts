import { Command } from 'commander';
import { Dropbox, type files } from 'dropbox';

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
  let list = await dbx.filesListFolder({ "path": "", "recursive": true });
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

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .action(async (options) => {
    const dbx = new Dropbox({ accessToken: process.env.API_TOKEN });
    await checkAccount(dbx);

    // for await (let doc of paperDocs(dbx)) {
    //   console.log(doc);
    // }

    const id = 'id:0pVIHY9IlbsAAAAAAAAPmA';
    const response = await dbx.filesExport({ path: id, export_format: 'markdown' });
    console.log(response.result.fileBinary.toString());
  });
program.parse(process.argv);
