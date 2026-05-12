import { Router } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import type { Request, Response } from 'express'
import { log } from '../utils/logger.js'

const router = Router()

// Use memory storage instead of disk storage
const storage = multer.memoryStorage()

// File filter
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true)
    } else {
        cb(new Error('仅允许上传图片'))
    }
}

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
})

// Upload endpoint
router.post('/', upload.single('image'), async (req: Request, res: Response) => {
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

        // Convert to Base64
        const base64Image = imageBuffer.toString('base64')
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`

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
                mimetype: req.file.mimetype,
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
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})

export const uploadRouter = router
