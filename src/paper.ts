import { Dropbox, DropboxAuth, type DropboxAuthOptions, type DropboxOptions, type files } from 'dropbox';
import PQueue from 'p-queue';
import open from 'open';
import path, { resolve } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';

type ListResult = (files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference);

async function checkAccount(dbx: Dropbox) {
  await dbx.checkUser({});

  const features = await dbx.rpcRequest("users/features/get_values", { features: ["paper_as_files"] }, 'user', 'api');
  if (!features.result.values[0].paper_as_files.enabled) {
    console.error("Paper as files feature is not enabled for this user");
    process.exit(1);
  }
}

export function looksLikePaper(entry: ListResult): boolean {
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

async function login(dbx: Dropbox, auth: DropboxAuth) {
  const port = 31727;
  const redirectUri = `http://localhost:${port}`;

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = await auth.getAuthenticationUrl(redirectUri, state, 'code', 'offline', [], 'none', true);

  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject("Timeout"), 120_000);
    const server = http.createServer(async (req, res) => {
      clearTimeout(timeout);
      const url = new URL(req.url!, redirectUri);
      const code = url.searchParams.get('code')!;
      const stateParam = url.searchParams.get('state');
      if (state !== stateParam) {
        res.end("Invalid state");
        reject("Invalid state");
        return;
      }

      try {
        const token = await auth.getAccessTokenFromCode(redirectUri, code);
        res.end("Authenticated, you can close this tab now");
        server.close();
        resolve((token.result as any).refresh_token);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, 'localhost');
  });

  open(authUrl.toString());
  const newRefreshToken = await ready;
  console.log("Refresh token:", newRefreshToken);
  auth.setRefreshToken(newRefreshToken);
}

async function getDropbox(): Promise<Dropbox> {
  const options: DropboxAuthOptions = { clientId: '5190eemvdo23cgj' };
  const refreshToken = process.env.REFRESH_TOKEN;
  if (refreshToken) {
    options.refreshToken = refreshToken;
  }

  const auth = new DropboxAuth(options);
  const dbx = new Dropbox({ auth });

  if (auth.getRefreshToken()) {
    auth.checkAndRefreshAccessToken();
  } else {
    await login(dbx, auth);
  }
  return dbx
}

export async function exportAll(output: string) {
  const dbx = await getDropbox();
  await checkAccount(dbx);

  const pq = new PQueue({ concurrency: 16 });
  console.log('Starting list...');
  for await (let doc of paperDocs(dbx)) {
    pq.add(async () => await exportDoc(output, dbx, doc));
  }
  await pq.onIdle();
}
