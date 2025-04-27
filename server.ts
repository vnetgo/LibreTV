// 导入必要的 Deno 模块
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

/**
 * 简单的静态文件服务器
 * 用于在 Deno Deploy 上托管 LibreTV 前端项目
 */

// MIME 类型映射
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

// 获取文件的 MIME 类型
function getMimeType(path: string): string {
  const extension = path.substring(path.lastIndexOf("."));
  return MIME_TYPES[extension] || "application/octet-stream";
}

// 处理请求的主函数
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let path = url.pathname;
  
  // 处理根路径请求，返回 index.html
  if (path === "/" || path === "") {
    path = "/index.html";
  }

  try {
    // 尝试读取请求的文件
    const file = await Deno.readFile(`.${path}`);
    
    // 返回文件内容和适当的 MIME 类型
    return new Response(file, {
      headers: {
        "Content-Type": getMimeType(path),
        "Cache-Control": "max-age=3600",
      },
    });
  } catch (error) {
    // 如果文件不存在，返回 404 错误
    if (error instanceof Deno.errors.NotFound) {
      // 如果找不到文件，尝试返回 index.html (SPA 应用支持)
      if (!path.includes(".")) {
        try {
          const indexFile = await Deno.readFile("./index.html");
          return new Response(indexFile, {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "max-age=3600",
            },
          });
        } catch {
          return new Response("404 Not Found", { status: 404 });
        }
      }
      return new Response("404 Not Found", { status: 404 });
    }
    
    // 其他错误返回 500
    return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
  }
}

// 启动服务器
console.log("LibreTV 服务器启动在 http://localhost:8000");
serve(handleRequest, { port: 8000 });