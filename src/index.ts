import { Command } from 'commander';
import { Dropbox } from 'dropbox';

const program = new Command();
program
  .version('1.0.0')
  .description('Export Dropbox Paper 2020+ documents')
  .action(async (options) => {
    const dbx = new Dropbox({ accessToken: process.env.API_TOKEN });
    await dbx.checkUser({});

    const features = await dbx.rpcRequest("users/features/get_values", { features: ["paper_as_files"] }, 'user', 'api');
    if (!features.result.values[0].paper_as_files.enabled) {
      console.error("Paper as files feature is not enabled for this user");
      process.exit(1);
    }

    let list = await dbx.filesListFolder({"path": "", "recursive": true});
    while (true) {
      for (let entry of list.result.entries) {
        if (entry['.tag'] == 'file' && entry.name.endsWith('.paper')) { // TODO: better way to check? also papert
          console.log(entry);
        }
      }

      if (!list.result.has_more) {
        break;
      }
      list = await dbx.filesListFolderContinue({"cursor": list.result.cursor});
    }
  });
program.parse(process.argv);
