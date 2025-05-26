import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { renderFileToString } from "https://deno.land/x/dejs@0.10.2/mod.ts";
import { config as dotenvConfig } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import { crypto } from "https://deno.land/std@0.207.0/crypto/mod.ts";
import { toHashString } from "https://deno.land/std@0.207.0/crypto/to_hash_string.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.207.0/path/mod.ts";

const env = dotenvConfig();

const __filename = fromFileUrl(import.meta.url);
const __dirname = dirname(__filename);

const config = {
  port: parseInt(env.PORT || "8080"),
  password: env.PASSWORD || '',
  corsOrigin: env.CORS_ORIGIN || '*',
  timeout: parseInt(env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(env.MAX_RETRIES || '2'),
  cacheMaxAge: env.CACHE_MAX_AGE || '1d', // Oak的send函数有自己的缓存控制
  userAgent: env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: env.DEBUG === 'true'
};

const log = (...args: any[]) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = new Application();
const router = new Router();

// CORS 中间件 (Oak 内置了对 CORS 的支持，但可以更细致地配置)
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", config.corsOrigin);
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  await next();
});

app.use(async (ctx, next) => {
  ctx.response.headers.set('X-Content-Type-Options', 'nosniff');
  ctx.response.headers.set('X-Frame-Options', 'DENY');
  ctx.response.headers.set('X-XSS-Protection', '1; mode=block');
  await next();
});

async function sha256Hash(input: string): Promise<string> {
  const messageBuffer = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', messageBuffer);
  return toHashString(hashBuffer);
}

async function renderPage(filePath: string, password?: string): Promise<string> {
  let content = await Deno.readTextFile(filePath);
  if (password && password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  }
  return content;
}

router.get(['/', '/index.html', '/player.html'], async (ctx) => {
  try {
    let filePath;
    switch (ctx.request.url.pathname) {
      case '/player.html':
        filePath = join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = join(__dirname, 'index.html');
        break;
    }
    const content = await renderPage(filePath, config.password);
    ctx.response.body = content;
    ctx.response.type = "html";
  } catch (error) {
    console.error('页面渲染错误:', error);
    ctx.response.status = 500;
    ctx.response.body = '读取静态页面失败';
  }
});

router.get('/s=:keyword', async (ctx) => {
  try {
    const filePath = join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    ctx.response.body = content;
    ctx.response.type = "html";
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    ctx.response.status = 500;
    ctx.response.body = '读取静态页面失败';
  }
});

function isValidUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    const blockedHostnames = (env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    const blockedPrefixes = (env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');

    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;

    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

router.get('/proxy/:encodedUrl', async (ctx) => {
  try {
    const encodedUrl = ctx.params.encodedUrl;
    if (!encodedUrl) {
        ctx.response.status = 400;
        ctx.response.body = '无效的 URL';
        return;
    }
    const targetUrl = decodeURIComponent(encodedUrl);

    if (!isValidUrl(targetUrl)) {
      ctx.response.status = 400;
      ctx.response.body = '无效的 URL';
      return;
    }

    log(`代理请求: ${targetUrl}`);

    let retries = 0;
    const makeRequest = async (): Promise<Response> => {
      try {
        return await fetch(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': config.userAgent
          },
          // Deno.fetch 不直接支持 timeout，需要 AbortController
        });
      } catch (error) {
        if (retries < config.maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${config.maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    const sensitiveHeaders = (
      env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');

    response.headers.forEach((value, key) => {
        if (!sensitiveHeaders.includes(key.toLowerCase())) {
            ctx.response.headers.set(key, value);
        }
    });
    
    ctx.response.status = response.status;
    ctx.response.body = response.body;

  } catch (error) {
    console.error('代理请求错误:', error.message || error);
    ctx.response.status = 500;
    ctx.response.body = `请求失败: ${error.message || error}`;
  }
});

// 静态文件服务 (放在路由之后，作为回退)
app.use(async (ctx, next) => {
  try {
    await send(ctx, ctx.request.url.pathname, {
      root: __dirname,
      index: "index.html", // 如果是目录，则提供 index.html
      // maxage: config.cacheMaxAge // send 函数有自己的缓存控制，但单位是毫秒
    });
  } catch (e) {
    // 如果文件未找到，则传递给下一个中间件 (404处理)
    await next();
  }
});

// 错误处理中间件
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('服务器错误:', err);
    ctx.response.status = 500;
    ctx.response.body = '服务器内部错误';
  }
});

// 404 处理
app.use(async (ctx) => {
  if (!ctx.response.body) {
    ctx.response.status = 404;
    ctx.response.body = '页面未找到';
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`服务器运行在 http://localhost:${config.port}`);
if (config.password !== '') {
  console.log('登录密码已设置');
}

await app.listen({ port: config.port });
