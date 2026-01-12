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
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: '未上传任何文件'
            })
        }

        // Generate unique filename
        const uniqueName = `${uuidv4()}${req.file.originalname.split('.').pop() ? '.' + req.file.originalname.split('.').pop() : ''}`
        
        // Compress the image using sharp (lossy compression with balanced quality)
        const compressedBuffer = await sharp(req.file.buffer)
            .withMetadata() // Preserve metadata
            .png({ quality: 80, compressionLevel: 9 }) // Lossy PNG compression with 80% quality
            .jpeg({ quality: 80, progressive: true, optimizeScans: true }) // Lossy JPEG compression with 80% quality
            .toBuffer()

        // Convert to Base64
        const base64Image = compressedBuffer.toString('base64')
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`

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
        console.error('Error uploading file:', error)
        res.status(500).json({
            success: false,
            error: '文件上传失败'
        })
    }
})

export const uploadRouter = router
