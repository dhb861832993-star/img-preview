# img-preview

在 DeepSeek Harness 对话框内**直接内联展示本地图片**的插件：不用再给文件路径让用户手动打开。

> 🔌 生态：仓库已挂 `#dsh` · `#dsh-plugin` · `#deepseek-harness` · `#image-preview` topic，欢迎社区收录。

- 宿主端：注册 `img_serve` 工具（校验图片路径、签发可访问 URL）与 `/plugins/img-preview/files` 回环文件路由（仅服务工作区内的 png/jpg/jpeg/webp/gif/avif/bmp/svg/ico/tga；**TGA 自动转码为 PNG**，浏览器原生不显示 TGA）。
- 客户端：检测 ` ```img ` 栅栏，渲染为内联图片（支持标题、点击看原图、多图网格）。
- 系统提示：自动注入使用说明，图片生成/出现后主动触发展示。

## 用法（对 Agent 生效）

```bash
# 工具
img_serve(path: "H:/工作-deepseek/dm_output/xxx.png")
```

成功后回复中输出：

````text
```img
{"path":"H:/工作-deepseek/dm_output/xxx.png","label":"可选标题"}
```
````

多图：

````text
```img
{"images":[{"path":"a.png"},{"path":"b.png","label":"B"}]}
```
````

## 安装

```sh
# GitHub 仓库安装（社区推荐方式）
dsh plugin --profile web add github:dhb861832993-star/img-preview

# 或本地开发（link 方式）
dsh plugin --profile web add link:H:/工作-deepseek/img-preview
```

重启 `dsh web` 服务，新会话生效。安装后模型会自动获得 `img_serve` 工具并在回复中直接内联展示图片。

## 安全模型

- 浏览器无法直接读本地磁盘，由宿主通过回环文件路由提供图片。
- 仅允许工作区根目录内的路径（规范化 + 前缀校验，防目录穿越）。
- 仅允许图片扩展名（png/jpg/jpeg/webp/gif/avif/bmp/svg/ico/tga），超 128 MiB 拒绝。
- TGA 在宿主端解码（支持 1/2/3/9/10/11 类型、8/16/24/32 位深、RLE 压缩、双原点约定）并用 `node:zlib` 编码为 PNG 输出，插件保持零依赖。
- SVG 经 `<img>` 渲染时不执行脚本（浏览器图片上下文屏蔽脚本），点击看原图走新标签页。
