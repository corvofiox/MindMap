import { Router } from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import type { Request, Response } from 'express'
import sharp from 'sharp'

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
        console.log('[UPLOAD] Request received')
        console.log('[UPLOAD] File:', req.file ? 'found' : 'NOT FOUND')

        if (!req.file) {
            console.log('[UPLOAD] ERROR: No file in request')
            return res.status(400).json({
                success: false,
                error: '未上传任何文件'
            })
        }

        console.log('[UPLOAD] File details:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        })

        // Generate unique filename
        const uniqueName = `${uuidv4()}${req.file.originalname.split('.').pop() ? '.' + req.file.originalname.split('.').pop() : ''}`

        console.log('[UPLOAD] Starting sharp processing...')
        // Compress the image using sharp (lossy compression with balanced quality)
        const compressedBuffer = await sharp(req.file.buffer)
            .withMetadata() // Preserve metadata
            .png({ quality: 80, compressionLevel: 9 }) // Lossy PNG compression with 80% quality
            .jpeg({ quality: 80, progressive: true, optimizeScans: true }) // Lossy JPEG compression with 80% quality
            .toBuffer()

        console.log('[UPLOAD] Sharp processing complete, size:', compressedBuffer.length)

        // Convert to Base64
        const base64Image = compressedBuffer.toString('base64')
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`

        console.log('[UPLOAD] Upload successful')
        res.json({
            success: true,
            data: {
                url: dataUrl, // Return data URL instead of file path
                filename: uniqueName,
                mimetype: req.file.mimetype,
                size: compressedBuffer.length, // Return compressed size
                originalSize: req.file.size // Optional: return original size for reference
            }
        })
    } catch (error) {
        console.error('[UPLOAD] ERROR:', error)
        if (error instanceof Error) {
            console.error('[UPLOAD] Error name:', error.name)
            console.error('[UPLOAD] Error message:', error.message)
            console.error('[UPLOAD] Error stack:', error.stack)
        }
        res.status(500).json({
            success: false,
            error: '文件上传失败',
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})

export const uploadRouter = router
