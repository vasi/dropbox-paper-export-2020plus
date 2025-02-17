import { Dropbox, DropboxAuth, type DropboxAuthOptions } from "dropbox";
import crypto from 'crypto';
import http from 'http';
import open from 'open';

async function login(dbx: Dropbox) {
  const port = 31727;
  const redirectUri = `http://localhost:${port}`;

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = await auth.getAuthenticationUrl(redirectUri, state, 'code', 'offline',
    [], 'none', true);

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
        const token = await dbx.auth.getAccessTokenFromCode(redirectUri, code);
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
  dbx.auth.setRefreshToken(newRefreshToken);
}

async function checkPaperSupport(dbx: Dropbox) {
  await dbx.checkUser({});

  const features = await dbx.rpcRequest("users/features/get_values",
    { features: ["paper_as_files"] }, 'user', 'api');
  if (!features.result.values[0].paper_as_files.enabled) {
    console.error("Paper as files feature is not enabled for this user");
    process.exit(1);
  }
}

export default async function getDropbox(refreshToken?: string): Promise<Dropbox> {
  const options: DropboxAuthOptions = { clientId: '5190eemvdo23cgj' };
  if (refreshToken) {
    options.refreshToken = refreshToken;
  }

  const auth = new DropboxAuth(options);
  const dbx = new Dropbox({ auth });

  if (auth.getRefreshToken()) {
    auth.checkAndRefreshAccessToken();
  } else {
    await login(dbx);
  }

  await checkPaperSupport(dbx);

  return dbx
}
