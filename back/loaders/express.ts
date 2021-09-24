import { Request, Response, NextFunction, Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import routes from '../api';
import config from '../config';
import jwt from 'express-jwt';
import fs from 'fs';
import { getPlatform, getToken } from '../config/util';
import Container from 'typedi';
import OpenService from '../services/open';
import rewrite from 'express-urlrewrite';

export default ({ app }: { app: Application }) => {
  app.enable('trust proxy');
  app.use(cors());

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
  app.use(
    jwt({
      secret: config.secret as string,
      algorithms: ['HS384'],
    }).unless({
      path: [
        '/api/login',
        '/api/crons/status',
        /^\/open\//,
        '/api/user/two-factor/login',
      ],
    }),
  );

  app.use((req: Request, res, next) => {
    if (!req.headers) {
      req.platform = 'desktop';
    } else {
      const platform = getPlatform(req.headers['user-agent'] || '');
      req.platform = platform;
    }
    return next();
  });

  app.use(async (req, res, next) => {
    const headerToken = getToken(req);
    if (req.path.startsWith('/open/')) {
      const openService = Container.get(OpenService);
      const doc = await openService.findTokenByValue(headerToken);
      if (doc && doc.tokens.length > 0) {
        const currentToken = doc.tokens.find((x) => x.value === headerToken);
        const key =
          req.path.match(/\/open\/([a-z]+)\/*/) &&
          req.path.match(/\/open\/([a-z]+)\/*/)[1];
        if (
          doc.scopes.includes(key as any) &&
          currentToken &&
          currentToken.expiration >= Math.round(Date.now() / 1000)
        ) {
          return next();
        }
      }
    }

    if (
      !headerToken &&
      req.path &&
      (req.path === '/api/login' ||
        req.path === '/open/auth/token' ||
        req.path === '/api/user/two-factor/login')
    ) {
      return next();
    }
    const remoteAddress = req.socket.remoteAddress;
    if (
      remoteAddress === '::ffff:127.0.0.1' &&
      req.path === '/api/crons/status'
    ) {
      return next();
    }

    const data = fs.readFileSync(config.authConfigFile, 'utf8');
    if (data) {
      const { token = '', tokens = {} } = JSON.parse(data);
      console.log(tokens);
      console.log(req.platform);
      console.log(tokens[req.platform]);
      if (headerToken === token || tokens[req.platform] === headerToken) {
        console.log('yes');
        return next();
      }
    }

    const err: any = new Error('UnauthorizedError');
    err.status = 401;
    next(err);
  });

  app.use(rewrite('/open/*', '/api/$1'));
  app.use(config.api.prefix, routes());

  app.use((req, res, next) => {
    const err: any = new Error('Not Found');
    err['status'] = 404;
    next(err);
  });

  app.use(
    (
      err: Error & { status: number },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      if (err.name === 'UnauthorizedError') {
        return res
          .status(err.status)
          .send({ code: 401, message: err.message })
          .end();
      }
      return next(err);
    },
  );

  app.use(
    (
      err: Error & { status: number },
      req: Request,
      res: Response,
      next: NextFunction,
    ) => {
      res.status(err.status || 500);
      res.json({
        code: err.status || 500,
        message: err.message,
      });
    },
  );
};
