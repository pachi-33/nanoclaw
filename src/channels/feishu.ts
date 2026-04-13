import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';

import { registerChannel, ChannelOpts } from './registry.js';

// ---- 配置 ----

const JID_PREFIX = 'fs:';
const CARD_THRESHOLD = 500;
const MD_PATTERN = /```|\*\*|^##?\s|^\|.*\||\*[^*\s]|^[-*+]\s|^>\s/m;

// ---- 多媒体安全限制 ----
const MAX_MERGE_TEXT_LEN = 8000;
const MAX_MERGE_IMAGES = 5;
const MAX_MERGE_DEPTH = 1;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// 发送图片路径检测模式：[图片: path]、[image: path]、![alt](path)
// 支持 /workspace/group/ 容器路径和宿主机绝对路径
const IMAGE_SEND_PATTERN =
  /(?:\[(?:图片|image):\s*(\/[^\]\s]+)\]|!\[.*?\]\((\/[^\s)]+)\))/gi;

// 发送文件路径检测模式：[文件: path]、[file: path]
const FILE_SEND_PATTERN = /\[(?:文件|file):\s*(\/[^\]\s]+)\]/gi;

// 飞书图片 API 支持的格式（234011: Can't recognize image format 之外的都走文件通道）
const FEISHU_IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
  '.ico',
  '.heic',
]);

/** 根据扩展名推断飞书文件类型 */
function feishuFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.mp4', '.mov', '.avi'].includes(ext)) return 'mp4';
  if (['.opus', '.ogg'].includes(ext)) return 'opus';
  return 'stream'; // 通用二进制，支持 txt/md/zip 等所有文件
}

// ---- 工具函数 ----

/** 从 JID 提取飞书 chat_id */
function chatIdFromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

/** 判断文本是否应该用卡片发送 */
function shouldUseCard(text: string): boolean {
  return text.length > CARD_THRESHOLD || MD_PATTERN.test(text);
}

// ---- 飞书 Channel 实现 ----

export class FeishuChannel implements Channel {
  readonly name = 'feishu';

  private client: lark.Client;
  private ws: lark.WSClient | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;

  // 机器人自身的 open_id，用于识别 @机器人 mention
  private botOpenId: string | null = null;

  // 记录 jid → { messageId, reactionId }，用于移除 typing indicator
  private typingReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();

  constructor(appId: string, appSecret: string, opts: ChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });
  }

  // ---- Channel 接口 ----

  async connect(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        this.handleMessage(data).catch((err: any) => {
          logger.error({ err }, '飞书消息处理失败');
        });
      },
    });

    this.ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      eventDispatcher: dispatcher,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    } as ConstructorParameters<typeof lark.WSClient>[0]);

    await (
      this.ws as unknown as {
        start(p: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
      }
    ).start({ eventDispatcher: dispatcher });
    this.connected = true;

    // 获取机器人自身 open_id，用于将 @机器人 替换为 @ASSISTANT_NAME 以匹配触发词
    try {
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const tokenData = (await tokenResp.json()) as {
        tenant_access_token?: string;
      };
      if (tokenData.tenant_access_token) {
        const botResp = await fetch(
          'https://open.feishu.cn/open-apis/bot/v3/info',
          {
            headers: {
              Authorization: `Bearer ${tokenData.tenant_access_token}`,
            },
          },
        );
        const botData = (await botResp.json()) as {
          bot?: { open_id?: string };
        };
        this.botOpenId = botData?.bot?.open_id ?? null;
      }
    } catch {
      /* 非致命 */
    }

    logger.info({ botOpenId: this.botOpenId }, '飞书 WebSocket 已连接');
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('飞书 WebSocket 已断开');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);

    // 统一媒体提取与发送（图片/文件标记提取、文本发送、媒体上传，互不阻塞）
    const groupFolder = this.getGroupFolder(jid);
    await this.extractAndSendMedia(chatId, text, groupFolder);
  }

  /** 统一路径解析：容器路径 /workspace/group/xxx → 宿主机路径，绝对路径直接用 */
  private resolveMediaPath(inputPath: string, groupFolder: string): string {
    if (inputPath.startsWith('/workspace/group/')) {
      const relativePath = inputPath.replace(/^\/workspace\/group\//, '');
      return path.join(resolveGroupFolderPath(groupFolder), relativePath);
    }
    // 正则只匹配以 / 开头的路径，此处必为绝对路径
    return inputPath;
  }

  /** 统一媒体标记提取与发送：从文本中提取 [图片:] [文件:] 标记，上传并发送，文本/媒体互不阻塞 */
  private async extractAndSendMedia(
    chatId: string,
    text: string,
    groupFolder: string | null,
  ): Promise<void> {
    // 用 matchAll + new RegExp 副本避免全局正则 lastIndex 状态污染
    const imageMatches = [
      ...text.matchAll(new RegExp(IMAGE_SEND_PATTERN.source, 'gi')),
    ].map((m) => m[1] || m[2]);
    const fileMatches = [
      ...text.matchAll(new RegExp(FILE_SEND_PATTERN.source, 'gi')),
    ].map((m) => m[1]);

    const hasMedia = imageMatches.length > 0 || fileMatches.length > 0;

    // 无标记 → 直接发文本
    if (!hasMedia) {
      await this.sendPlainOrCard(chatId, text);
      return;
    }

    // groupFolder 为 null → 无法上传媒体，原文本直接发
    if (!groupFolder) {
      logger.warn('群未注册 groupFolder，跳过媒体提取，原文本直接发送');
      await this.sendPlainOrCard(chatId, text);
      return;
    }

    // strip 标记，合并连续空白，发送剩余文本
    const remainingText = text
      .replace(new RegExp(IMAGE_SEND_PATTERN.source, 'gi'), '')
      .replace(new RegExp(FILE_SEND_PATTERN.source, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    let textSent = !remainingText; // 无文本需要发则视为成功
    if (remainingText) {
      try {
        await this.sendPlainOrCard(chatId, remainingText);
        textSent = true;
      } catch (err) {
        logger.warn({ err }, '飞书文本卡片发送失败，媒体发送继续');
      }
    }

    const errors: Error[] = [];

    // 逐个发送图片标记：支持的格式走图片 API，不支持的走文件 API，图片 API 失败 fallback 文件 API
    for (const imgPath of imageMatches) {
      const ext = path.extname(imgPath).toLowerCase();
      const useImageApi = FEISHU_IMAGE_EXTS.has(ext);
      try {
        if (useImageApi) {
          try {
            await this.sendImageMsg(chatId, imgPath, groupFolder);
          } catch (imgErr) {
            logger.warn(
              { err: imgErr, path: imgPath },
              '图片 API 失败，fallback 文件通道',
            );
            await this.sendFileMsg(chatId, imgPath, groupFolder);
          }
        } else {
          await this.sendFileMsg(chatId, imgPath, groupFolder);
        }
      } catch (err) {
        errors.push(err as Error);
        logger.error(
          { err, path: imgPath },
          '飞书媒体发送失败（图片+文件通道均失败）',
        );
      }
    }

    // 逐个发送文件标记
    for (const filePath of fileMatches) {
      try {
        await this.sendFileMsg(chatId, filePath, groupFolder);
      } catch (err) {
        errors.push(err as Error);
        logger.error({ err, path: filePath }, '飞书文件发送失败');
      }
    }

    // 文本和全部媒体都失败时，向调用方抛出错误
    if (
      !textSent &&
      errors.length === imageMatches.length + fileMatches.length
    ) {
      throw new Error(
        `飞书消息发送全部失败 (${errors.length} 个媒体): ${errors[0]?.message}`,
      );
    }
  }

  /** IPC send_message 专用：直接发消息，不触发进度卡片清理逻辑 */
  async sendDirectMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    const groupFolder = this.getGroupFolder(jid);
    await this.extractAndSendMedia(chatId, text, groupFolder);
  }

  /** 修改飞书群名称 */
  async renameChat(jid: string, name: string): Promise<void> {
    const chatId = jid.replace(JID_PREFIX, '');
    logger.info({ jid, chatId, name }, '[rename] 开始修改群名');
    try {
      const resp = await this.client.im.chat.update({
        path: { chat_id: chatId },
        data: { name },
      });
      logger.info({ jid, name, code: resp?.code }, '[rename] 群名已更新');
    } catch (err) {
      logger.warn({ err, jid, name }, '[rename] 修改群名失败');
    }
  }

  /** 发送纯文本或卡片消息（内部方法）。有 usage 时强制走卡片并追加脚注，卡片失败自动降级纯文本 */
  private async sendPlainOrCard(chatId: string, text: string): Promise<void> {
    if (shouldUseCard(text)) {
      const elements: unknown[] = [
        { tag: 'markdown', content: text, text_size: 'normal' },
      ];
      try {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              schema: '2.0',
              body: { elements },
            }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      } catch (cardErr) {
        // 卡片发送失败（如 invalid image keys），降级为纯文本
        logger.warn({ err: cardErr }, '飞书卡片发送失败，降级为纯文本');
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      }
    } else {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    }
  }

  async sendAuthCard(jid: string, authUrl: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    const card = JSON.stringify({
      elements: [
        {
          tag: 'markdown',
          content:
            '🔑 **需要飞书文档授权**\n\n要读取或创建飞书文档，需要你授权一次。\n授权后自动生效，无需重复操作。',
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '👉 点击授权' },
              type: 'primary',
              multi_url: { url: authUrl },
            },
          ],
        },
      ],
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '飞书文档授权' },
      },
    });
    try {
      await this.client.im.message.create({
        data: { receive_id: chatId, msg_type: 'interactive', content: card },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info({ jid }, '飞书授权卡片发送成功');
    } catch (err) {
      // schema 1.0 卡片失败时降级为纯文本链接
      logger.warn({ err }, '飞书授权卡片发送失败，降级为文本链接');
      try {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({
              text: `🔑 需要飞书文档授权\n\n请点击链接完成授权：${authUrl}\n\n授权后自动生效。`,
            }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      } catch (fallbackErr) {
        logger.error({ fallbackErr }, '飞书授权文本链接也发送失败');
      }
    }
  }

  async syncGroups(): Promise<void> {
    try {
      let pageToken: string | undefined;
      do {
        const resp = await this.client.im.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        const items = resp?.data?.items ?? [];
        for (const item of items) {
          if (item.chat_id && item.name) {
            const jid = `${JID_PREFIX}${item.chat_id}`;
            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              item.name,
              'feishu',
              true,
            );
          }
        }
        pageToken = resp?.data?.page_token;
      } while (pageToken);
      logger.info('飞书群列表同步完成');
    } catch (err) {
      logger.error({ err }, '飞书群列表同步失败');
    }
  }

  // ---- 内部方法 ----

  // 最近消息 ID 缓存（按 chat jid），用于 typing indicator
  private lastMessageIds = new Map<string, string>();

  private getGroupFolder(jid: string): string | null {
    const groups = this.opts.registeredGroups();
    return groups[jid]?.folder ?? null;
  }

  /** 获取 tenant_access_token（用于 REST API 调用） */
  private async getTenantAccessToken(): Promise<string | null> {
    try {
      const resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const data = (await resp.json()) as { tenant_access_token?: string };
      return data.tenant_access_token ?? null;
    } catch (err) {
      logger.error({ err }, '获取 tenant_access_token 失败');
      return null;
    }
  }

  /** 下载飞书图片到 group 目录，返回宿主机绝对路径 */
  private async downloadImage(
    messageId: string,
    imageKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      if (!token) return null;

      const groupDir = resolveGroupFolderPath(groupFolder);
      const imagesDir = path.join(groupDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });

      const filename = `${messageId}_${imageKey}.jpg`;
      const filePath = path.join(imagesDir, filename);

      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        logger.warn(
          { messageId, imageKey, status: resp.status },
          '飞书图片下载 HTTP 错误',
        );
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_IMAGE_SIZE) {
        logger.warn(
          { messageId, imageKey, size: buf.length },
          '图片超过 20MB 限制',
        );
        return null;
      }

      fs.writeFileSync(filePath, buf);
      logger.info(
        { messageId, imageKey, hostPath: filePath },
        '飞书图片下载成功',
      );
      return filePath;
    } catch (err) {
      logger.error({ err, messageId, imageKey }, '飞书图片下载失败');
      return null;
    }
  }

  /** 下载飞书文件到 group 目录，返回宿主机绝对路径 */
  private async downloadFile(
    messageId: string,
    fileKey: string,
    fileName: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      if (!token) return null;

      const groupDir = resolveGroupFolderPath(groupFolder);
      const filesDir = path.join(groupDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });

      // 文件名加 messageId 前缀防重名
      const safeFileName = fileName.replace(/[/\\]/g, '_');
      const filePath = path.join(filesDir, `${messageId}_${safeFileName}`);

      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        logger.warn(
          { messageId, fileKey, status: resp.status },
          '飞书文件下载 HTTP 错误',
        );
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      logger.info(
        { messageId, fileKey, fileName, hostPath: filePath, size: buf.length },
        '飞书文件下载成功',
      );
      return filePath;
    } catch (err) {
      logger.error({ err, messageId, fileKey }, '飞书文件下载失败');
      return null;
    }
  }

  /** 从飞书 post（富文本）中提取文本和图片 key */
  extractPostContent(parsed: Record<string, unknown>): {
    text: string;
    imageKeys: string[];
  } {
    const parts: string[] = [];
    const imageKeys: string[] = [];

    const title = ((parsed.title as string) || '').trim();
    if (title) parts.push(title);

    const content = parsed.content as
      | Array<Array<{ tag: string; text?: string; image_key?: string }>>
      | undefined;
    if (!content) return { text: parts.join('\n'), imageKeys };

    for (const line of content) {
      const lineTexts: string[] = [];
      for (const el of line) {
        if ((el.tag === 'text' || el.tag === 'a') && el.text) {
          lineTexts.push(el.text);
        } else if (el.tag === 'img' && el.image_key) {
          imageKeys.push(el.image_key);
        }
      }
      if (lineTexts.length > 0) parts.push(lineTexts.join(''));
    }

    return { text: parts.join('\n'), imageKeys };
  }

  /** 解析合并转发消息（参考 Nine adapter.py _parse_merge_forward） */
  private async parseMergeForward(
    messageId: string,
    groupFolder: string | null,
    depth: number = 0,
  ): Promise<{ text: string; imagePaths: string[] }> {
    if (depth > MAX_MERGE_DEPTH) {
      return { text: '[嵌套转发内容已省略]', imagePaths: [] };
    }

    const token = await this.getTenantAccessToken();
    if (!token) {
      return { text: '[合并转发消息，认证失败无法解析]', imagePaths: [] };
    }

    let items: Array<{
      message_id?: string;
      msg_type?: string;
      sender?: { id: string; sender_type: string };
      body?: { content: string };
    }>;
    try {
      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await resp.json()) as {
        code?: number;
        data?: { items?: typeof items };
      };
      if (data.code !== 0) {
        logger.error(
          { messageId, code: data.code },
          '飞书合并转发 API 返回错误',
        );
        return { text: '[合并转发消息，API 返回错误]', imagePaths: [] };
      }
      items = data.data?.items ?? [];
    } catch (err) {
      logger.error({ err, messageId }, '飞书合并转发 API 调用失败');
      return { text: '[合并转发消息，API 调用失败]', imagePaths: [] };
    }

    if (items.length === 0) {
      return { text: '[合并转发消息，无子消息]', imagePaths: [] };
    }

    const texts: string[] = [];
    const imagePaths: string[] = [];
    let totalTextLen = 0;
    let skippedCount = 0;

    for (const item of items) {
      const itemMsgType = item.msg_type ?? '';

      // 合并转发类型：递归解析（跳过自身）
      if (itemMsgType === 'merge_forward') {
        if (depth < MAX_MERGE_DEPTH) {
          const nestedId = item.message_id ?? '';
          if (nestedId && nestedId !== messageId) {
            const nested = await this.parseMergeForward(
              nestedId,
              groupFolder,
              depth + 1,
            );
            if (nested.text) {
              texts.push(nested.text);
              totalTextLen += nested.text.length;
            }
            imagePaths.push(...nested.imagePaths);
          }
        } else {
          texts.push('[嵌套转发内容已省略]');
        }
        continue;
      }

      const subContent = item.body?.content ?? '{}';
      const senderLabel = item.sender?.sender_type || item.sender?.id || '未知';

      // 按类型解析子消息
      let subText = '';
      const subImageKeys: string[] = [];
      try {
        const parsed = JSON.parse(subContent);
        if (itemMsgType === 'text') {
          subText = parsed.text ?? '';
        } else if (itemMsgType === 'image') {
          if (parsed.image_key) subImageKeys.push(parsed.image_key);
        } else if (itemMsgType === 'post') {
          const postResult = this.extractPostContent(parsed);
          subText = postResult.text;
          subImageKeys.push(...postResult.imageKeys);
        }
      } catch {
        subText = subContent;
      }

      // 文本长度限制
      if (subText) {
        if (totalTextLen + subText.length > MAX_MERGE_TEXT_LEN) {
          skippedCount++;
          continue;
        }
        texts.push(`[${senderLabel}]: ${subText}`);
        totalTextLen += subText.length;
      }

      // 下载图片（受数量限制）
      if (subImageKeys.length > 0 && groupFolder) {
        const remaining = MAX_MERGE_IMAGES - imagePaths.length;
        for (const key of subImageKeys.slice(0, Math.max(0, remaining))) {
          const imgPath = await this.downloadImage(
            item.message_id ?? messageId,
            key,
            groupFolder,
          );
          if (imgPath) imagePaths.push(imgPath);
        }
      }
    }

    if (skippedCount > 0) {
      texts.push(`[...还有 ${skippedCount} 条消息已省略]`);
    }

    return {
      text: texts.length > 0 ? `[转发消息]\n${texts.join('\n')}` : '[转发消息]',
      imagePaths,
    };
  }

  /** 上传并发送图片消息 */
  private async sendImageMsg(
    chatId: string,
    containerPath: string,
    groupFolder: string,
  ): Promise<void> {
    const hostPath = this.resolveMediaPath(containerPath, groupFolder);

    if (!fs.existsSync(hostPath)) {
      throw new Error(`图片文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    // 上传图片
    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append(
      'image',
      new Blob([fs.readFileSync(hostPath)]),
      path.basename(hostPath),
    );

    const uploadResp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/images',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    const uploadData = (await uploadResp.json()) as {
      data?: { image_key?: string };
    };
    const imageKey = uploadData?.data?.image_key;
    if (!imageKey) throw new Error('图片上传失败：未返回 image_key');

    // 发送图片消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  /** 上传并发送文件消息 */
  private async sendFileMsg(
    chatId: string,
    inputPath: string,
    groupFolder: string,
  ): Promise<void> {
    const hostPath = this.resolveMediaPath(inputPath, groupFolder);

    if (!fs.existsSync(hostPath)) {
      throw new Error(`文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    const filename = path.basename(hostPath);
    const fileType = feishuFileType(filename);

    // 上传文件
    const formData = new FormData();
    formData.append('file_type', fileType);
    formData.append('file_name', filename);
    formData.append('file', new Blob([fs.readFileSync(hostPath)]), filename);

    const uploadResp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/files',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    const uploadData = (await uploadResp.json()) as {
      data?: { file_key?: string };
    };
    const fileKey = uploadData?.data?.file_key;
    if (!fileKey)
      throw new Error(`文件上传失败：${JSON.stringify(uploadData)}`);

    // 发送文件消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  /** 获取被回复消息的内容和发送者名称 */
  private async fetchReplyContext(
    parentId: string,
  ): Promise<{ content: string; senderName: string } | null> {
    const token = await this.getTenantAccessToken();
    if (!token) return null;

    try {
      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${parentId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await resp.json()) as {
        code?: number;
        data?: {
          items?: Array<{
            msg_type?: string;
            sender?: { id: string; sender_type: string };
            body?: { content: string };
          }>;
        };
      };
      if (data.code !== 0 || !data.data?.items?.length) return null;

      const item = data.data.items[0];
      const msgType = item.msg_type ?? '';
      const rawContent = item.body?.content ?? '{}';
      const senderOpenId = item.sender?.id ?? '未知';

      // 提取文本内容
      let content = '';
      try {
        const parsed = JSON.parse(rawContent);
        if (msgType === 'text') {
          content = parsed.text ?? '';
        } else if (msgType === 'post') {
          // 富文本：提取纯文本部分
          const postResult = this.extractPostContent(parsed);
          content = postResult.text;
        } else if (msgType === 'image') {
          content = '[图片]';
        } else if (msgType === 'merge_forward') {
          content = '[合并转发消息]';
        } else if (msgType === 'interactive') {
          // 互动卡片：尝试提取标题或纯文本
          const header = parsed?.header?.title?.content;
          content = header ? `[卡片: ${header}]` : '[互动卡片]';
        } else {
          content = `[${msgType}]`;
        }
      } catch {
        content = '[无法解析]';
      }

      // 截断过长的引用内容
      if (content.length > 200) {
        content = content.slice(0, 200) + '...';
      }

      // 获取发送者名称
      let senderName = senderOpenId;
      const senderType = item.sender?.sender_type ?? '';
      if (senderType === 'app') {
        // bot 自己发的消息
        senderName = 'Andy';
      } else {
        // 尝试从 DB 获取发送者名称（比 open_id 更友好）
        try {
          const { getMessageById } = await import('../db.js');
          const row = getMessageById(parentId);
          if (row?.sender_name) {
            senderName = row.sender_name;
          }
        } catch {
          // DB 查不到就用 open_id
        }
      }

      return { content, senderName };
    } catch (err) {
      logger.warn({ err, parentId }, '获取被回复消息失败');
      return null;
    }
  }

  private async handleMessage(data: {
    sender: {
      sender_id?: { union_id?: string; user_id?: string; open_id?: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  }): Promise<void> {
    logger.info(
      {
        chatId: data.message.chat_id,
        msgType: data.message.message_type,
        senderType: data.sender.sender_type,
      },
      '飞书收到消息事件',
    );
    // 忽略机器人自己发的消息
    if (data.sender.sender_type === 'app') {
      logger.info(
        { chatId: data.message.chat_id },
        '忽略机器人消息 (sender_type=app)',
      );
      return;
    }

    const { message, sender } = data;
    const jid = `${JID_PREFIX}${message.chat_id}`;
    const senderId =
      sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? 'unknown';

    // 记录最近消息 ID（用于 typing indicator）
    this.lastMessageIds.set(jid, message.message_id);

    // 获取 group folder（图片下载需要）
    const groupFolder = this.getGroupFolder(jid);

    logger.info(
      { jid, msgType: message.message_type, senderId },
      '飞书开始解析消息内容',
    );

    // 解析消息内容
    let text = '';
    try {
      if (message.message_type === 'image') {
        // 图片消息：下载图片并标记路径
        const parsed = JSON.parse(message.content);
        const imageKey = parsed.image_key;
        if (imageKey && groupFolder) {
          const imgPath = await this.downloadImage(
            message.message_id,
            imageKey,
            groupFolder,
          );
          text = imgPath ? `[图片: ${imgPath}]` : '[图片: 下载失败]';
        } else if (imageKey) {
          text = '[图片: 群未注册，无法下载]';
        } else {
          return;
        }
      } else if (message.message_type === 'file') {
        // 文件消息：下载文件并标记路径
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        const fileName = parsed.file_name || 'unknown';
        if (fileKey && groupFolder) {
          const filePath = await this.downloadFile(
            message.message_id,
            fileKey,
            fileName,
            groupFolder,
          );
          text = filePath
            ? `[文件: ${filePath}] (${fileName})`
            : `[文件: 下载失败] (${fileName})`;
        } else if (fileKey) {
          text = `[文件: 群未注册，无法下载] (${fileName})`;
        } else {
          return;
        }
      } else if (message.message_type === 'audio') {
        // 语音消息：下载并标记路径（转写由其他 skill 处理）
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        if (fileKey && groupFolder) {
          const filePath = await this.downloadFile(
            message.message_id,
            fileKey,
            `voice_${message.message_id}.opus`,
            groupFolder,
          );
          text = filePath ? `[语音: ${filePath}]` : '[语音: 下载失败]';
        } else {
          return;
        }
      } else if (message.message_type === 'merge_forward') {
        // 合并转发：递归解析子消息
        const result = await this.parseMergeForward(
          message.message_id,
          groupFolder,
        );
        text = result.text;
        for (const imgPath of result.imagePaths) {
          text += `\n[图片: ${imgPath}]`;
        }
      } else {
        const parsed = JSON.parse(message.content);
        if (message.message_type === 'text') {
          text = parsed.text ?? '';
        } else if (message.message_type === 'post') {
          // 富文本：提取文本 + 图片
          const postResult = this.extractPostContent(parsed);
          text = postResult.text;
          if (postResult.imageKeys.length > 0 && groupFolder) {
            for (const imageKey of postResult.imageKeys) {
              const imgPath = await this.downloadImage(
                message.message_id,
                imageKey,
                groupFolder,
              );
              if (imgPath) text += `\n[图片: ${imgPath}]`;
            }
          }
        } else {
          // 其他消息类型暂不处理
          return;
        }
      }
    } catch (err) {
      logger.warn({ content: message.content, err }, '飞书消息内容解析失败');
      return;
    }

    if (!text.trim()) {
      logger.info({ jid }, '飞书消息内容为空，跳过');
      return;
    }

    // 替换 @mention 标记为名称；@机器人 → @ASSISTANT_NAME（匹配触发词）
    if (message.mentions) {
      for (const m of message.mentions) {
        const isBotMention = this.botOpenId && m.id.open_id === this.botOpenId;
        text = text.replace(
          m.key,
          isBotMention ? `@${ASSISTANT_NAME}` : `@${m.name}`,
        );
      }
    }

    // 通知元数据
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      undefined,
      'feishu',
      message.chat_type === 'group',
    );

    const senderName =
      message.mentions?.find((m) => m.id.open_id === senderId)?.name ??
      senderId;

    // 获取被回复消息的内容和发送者
    let replyContent: string | undefined;
    let replySenderName: string | undefined;
    if (message.parent_id) {
      const replyCtx = await this.fetchReplyContext(message.parent_id);
      if (replyCtx) {
        replyContent = replyCtx.content;
        replySenderName = replyCtx.senderName;
      }
    }

    const newMsg: NewMessage = {
      id: message.message_id,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      reply_to_message_id: message.parent_id,
      reply_to_message_content: replyContent,
      reply_to_sender_name: replySenderName,
      thread_id: message.root_id,
    };

    logger.info({ jid, text: text.slice(0, 80) }, '飞书消息分发到 onMessage');
    Promise.resolve(this.opts.onMessage(jid, newMsg)).catch((err) =>
      logger.error({ jid, err }, 'onMessage handler failed'),
    );
  }
}

// ---- 自注册 ----

registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    logger.debug('飞书凭证未配置，跳过 feishu channel');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
