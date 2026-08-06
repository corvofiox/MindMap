import { Router } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { log } from '../utils/logger.js'

const router = Router()

// Use memory storage instead of disk storage
const storage = multer.memoryStorage()

// File filter
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true)
    } else {
        // R5 #9: 错误信息明确列出支持的格式（SVG/BMP 等不支持——SVG 可内嵌
        // 脚本，直接按图片渲染/打开存在 XSS 风险，BMP 前端渲染不支持）。
        // R5 #7: 显式携带 statusCode=400——fileFilter 错误是客户端请求
        // 问题（文件类型不符），error.middleware 按 statusCode 返回 4xx，
        // 不能落入 500 让客户端误以为是服务端故障。
        const err = new Error('仅支持上传 PNG/JPEG/GIF/WebP 图片（不支持 SVG/BMP 等格式）') as Error & { statusCode?: number }
        err.statusCode = 400
        cb(err)
    }
}

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
})

// A5: 魔数嗅探——客户端声明的 mimetype 可伪造（如 image/svg+xml 实际是
// HTML/脚本），按文件头签名识别真实图片类型；无法识别则拒绝。
interface ImageSignature {
    mime: string
    match: (buf: Buffer) => boolean
}

const IMAGE_SIGNATURES: ImageSignature[] = [
    {
        mime: 'image/png',
        match: (b) => b.length >= 8
            && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
            && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
    },
    {
        mime: 'image/jpeg',
        match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
        mime: 'image/gif',
        match: (b) => b.length >= 6
            && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a'),
    },
    {
        mime: 'image/webp',
        match: (b) => b.length >= 12
            && b.toString('ascii', 0, 4) === 'RIFF'
            && b.toString('ascii', 8, 12) === 'WEBP',
    },
]

function sniffImageMime(buffer: Buffer): string | null {
    for (const sig of IMAGE_SIGNATURES) {
        if (sig.match(buffer)) return sig.mime
    }
    return null
}

// Upload endpoint（A5: 要求登录，杜绝匿名上传滥用）
router.post('/', authenticate, upload.single('image'), async (req: Request, res: Response) => {
  try {
    if (process.env.NODE_ENV === 'development') {
      log('Upload request received', {
        filename: req.file?.originalname,
        mimetype: req.file?.mimetype,
      })
    }

    if (!req.file) {
      log('Upload error: No file in request')
      return res.status(400).json({
        success: false,
        error: '未上传任何文件'
      })
    }

    if (process.env.NODE_ENV === 'development') {
      log('Upload file details', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      })
    }

        // A5: 魔数校验，拒绝伪造 mimetype 的非图片内容（保持嗅探，防 XSS——
        // 例如声明 image/svg+xml 实为 HTML/脚本的文件会被拒绝）。
        // R5 #9: 错误信息明确说明仅支持 PNG/JPEG/GIF/WebP（SVG 可内嵌脚本、
        // BMP 前端不支持，均被嗅探拒绝）。
        const sniffedMime = sniffImageMime(req.file.buffer)
        if (!sniffedMime) {
          log('Upload rejected: content does not match any supported image signature', {
            size: req.file.size,
          })
          return res.status(400).json({
            success: false,
            error: '仅支持 PNG/JPEG/GIF/WebP 图片格式（SVG/BMP 等格式不支持）'
          })
        }

        // Generate unique filename
        const uniqueName = `${uuidv4()}${req.file.originalname.split('.').pop() ? '.' + req.file.originalname.split('.').pop() : ''}`

        if (process.env.NODE_ENV === 'development') {
          log('Upload starting processing')
        }
        // Keep original image data without compression to preserve quality
        const imageBuffer = req.file.buffer

        if (process.env.NODE_ENV === 'development') {
          log('Upload processing complete', {
            originalSize: req.file.size,
            keptSize: imageBuffer.length,
          })
        }

        // Convert to Base64（mimetype 使用嗅探结果，而非客户端声明）
        const base64Image = imageBuffer.toString('base64')
        const dataUrl = `data:${sniffedMime};base64,${base64Image}`

        if (process.env.NODE_ENV === 'development') {
          log('Upload successful', {
            filename: uniqueName,
            size: imageBuffer.length,
          })
        }

        res.json({
            success: true,
            data: {
                url: dataUrl, // Return data URL instead of file path
                filename: uniqueName,
                mimetype: sniffedMime,
                size: imageBuffer.length,
                originalSize: req.file.size
            }
        })
    } catch (error) {
        if (error instanceof Error) {
          log('Upload error', {
            name: error.name,
            message: error.message,
            stack: error.stack,
          })
        }
        res.status(500).json({
            success: false,
            error: '文件上传失败',
        })
    }
})

export const uploadRouter = router
