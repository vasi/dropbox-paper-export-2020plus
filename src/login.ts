import { Dropbox, DropboxAuth, type DropboxAuthOptions, type users } from "dropbox";
import crypto from 'crypto';
import http from 'http';
import open from 'open';

export const defaultRedirectPort = 31727

async function login(dbx: Dropbox, port?: number) {
  port = port ?? defaultRedirectPort;
  const redirectUri = `http://localhost:${port}`;

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = await dbx.auth.getAuthenticationUrl(redirectUri, state, 'code', 'offline',
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
        resolve(token.result.refresh_token);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(port, 'localhost');
  });

  open(authUrl.toString());
  console.log("Tried to open an authentication URL in your browser. If it didn't work, please open it manually:");
  console.log(authUrl.toString());
  const newRefreshToken = await ready;
  dbx.auth.setRefreshToken(newRefreshToken);
}

async function checkPaperSupport(dbx: Dropbox) {
  await dbx.checkUser({});

  const features = await dbx.rpcRequest<users.UserFeaturesGetValuesBatchResult>("users/features/get_values",
    { features: ["paper_as_files"] }, 'user', 'api');
  const feature = features.result.values[0] as users.UserFeatureValuePaperAsFiles;
  if (feature.paper_as_files[".tag"] !== "enabled") {
    console.error("Paper as files feature is not enabled for this user");
    process.exit(1);
  }
}

interface AuthOpts {
  clientId?: string,
  refreshToken?: string,
  redirectPort?: number,
}

export default async function getDropbox(opts: AuthOpts): Promise<Dropbox> {
  const options: DropboxAuthOptions = {
    clientId: opts.clientId ?? '5190eemvdo23cgj',
    ...(opts.refreshToken && { refreshToken: opts.refreshToken }),
    ...(opts.redirectPort && { redirectPort: opts.redirectPort }),
  };
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
