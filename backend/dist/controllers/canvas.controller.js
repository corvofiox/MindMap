import { Router } from 'express';
import { db, scheduleSave } from '../database/connection.js';
import { canvases, folders, projects } from '../database/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { transformResponse, transformResponseArray } from '../utils/transformResponse.js';
import { log } from '../utils/logger.js';
export const canvasRouter = Router();
canvasRouter.get('/detail/:id', authenticate, asyncHandler(async (req, res) => {
    const canvasId = parseInt(req.params.id);
    const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
    });
    if (!canvas) {
        return res.status(404).json({
            success: false,
            error: '画布未找到',
        });
    }
    const transformedCanvas = transformResponse(canvas, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedCanvas,
    });
}));
canvasRouter.get('/:projectId', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const projectCanvases = await db.query.canvases.findMany({
        where: eq(canvases.projectId, projectId),
        orderBy: (canvases, { asc }) => [asc(canvases.sortOrder)],
    });
    const transformedCanvases = transformResponseArray(projectCanvases, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedCanvases,
    });
}));
canvasRouter.post('/:projectId', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    const { name, folderId } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const [newCanvas] = await db
        .insert(canvases)
        .values({
        name,
        projectId,
        folderId: folderId || null,
    })
        .returning();
    scheduleSave();
    const transformedCanvas = transformResponse(newCanvas, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedCanvas,
    });
}));
canvasRouter.put('/:id', authenticate, asyncHandler(async (req, res) => {
    const canvasId = parseInt(req.params.id);
    const { name, yjsData, previewText, thumbnail, folderId, sortOrder } = req.body;
    log('PUT canvas - Start', { canvasId, userId: req.user.id, body: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder } });
    try {
        const canvas = await db.query.canvases.findFirst({
            where: eq(canvases.id, canvasId),
        });
        log('PUT canvas - Canvas query result', { canvasId, canvasFound: !!canvas, canvas: canvas ? JSON.stringify(canvas) : null });
        if (!canvas) {
            log('PUT canvas - Canvas not found', { canvasId });
            return res.status(404).json({
                success: false,
                error: '画布未找到',
            });
        }
        const canvasProjectId = canvas.project_id || canvas.projectId;
        const project = await db.query.projects.findFirst({
            where: eq(projects.id, canvasProjectId),
        });
        log('PUT canvas - Project query result', { canvasId, projectId: canvasProjectId, projectFound: !!project });
        if (!project) {
            log('PUT canvas - Project not found', { canvasId, projectId: canvasProjectId });
            return res.status(404).json({
                success: false,
                error: '项目未找到',
            });
        }
        const projectOwnerId = project.owner_id || project.ownerId;
        if (projectOwnerId !== req.user.id) {
            log('PUT canvas - Access denied', { canvasId, projectOwnerId, userId: req.user.id });
            return res.status(403).json({
                success: false,
                error: '访问被拒绝',
            });
        }
        log('PUT canvas - About to update', { canvasId, updateData: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder } });
        const updateData = {
            updatedAt: Math.floor(Date.now() / 1000),
        };
        if (name !== undefined) {
            updateData.name = name;
        }
        if (yjsData !== undefined) {
            updateData.yjsData = yjsData;
        }
        if (previewText !== undefined) {
            updateData.previewText = previewText;
        }
        if (thumbnail !== undefined) {
            updateData.thumbnail = thumbnail;
        }
        if (folderId !== undefined) {
            updateData.folderId = folderId;
        }
        if (sortOrder !== undefined) {
            updateData.sortOrder = sortOrder;
        }
        log('PUT canvas - Final update data', { canvasId, updateData });
        const [updatedCanvas] = await db
            .update(canvases)
            .set(updateData)
            .where(eq(canvases.id, canvasId))
            .returning();
        scheduleSave();
        log('PUT canvas - Success', { canvasId });
        const transformedCanvas = transformResponse(updatedCanvas, ['createdAt', 'updatedAt']);
        res.json({
            success: true,
            data: transformedCanvas,
        });
    }
    catch (error) {
        log('PUT canvas - Error', { canvasId, error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
}));
canvasRouter.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const canvasId = parseInt(req.params.id);
    log('DELETE canvas - Start', { canvasId, userId: req.user.id });
    const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
    });
    if (!canvas) {
        log('DELETE canvas - Canvas not found', { canvasId });
        return res.status(404).json({
            success: false,
            error: '画布未找到',
        });
    }
    const canvasProjectId = canvas.project_id || canvas.projectId;
    log('DELETE canvas - Canvas found', { canvasId, projectId: canvasProjectId, canvas: JSON.stringify(canvas) });
    try {
        log('DELETE canvas - About to query project', { canvasId, projectId: canvasProjectId, projectIdType: typeof canvasProjectId });
        const project = await db.query.projects.findFirst({
            where: eq(projects.id, canvasProjectId),
        });
        log('DELETE canvas - Project query result', { canvasId, projectId: canvasProjectId, projectFound: !!project });
        if (!project) {
            log('DELETE canvas - Project not found', { canvasId, projectId: canvasProjectId });
            return res.status(404).json({
                success: false,
                error: '项目未找到',
            });
        }
        const projectOwnerId = project.owner_id || project.ownerId;
        log('DELETE canvas - Checking ownership', { canvasId, projectOwnerId, userId: req.user.id });
        if (projectOwnerId !== req.user.id) {
            log('DELETE canvas - Access denied', { canvasId, projectOwnerId, userId: req.user.id });
            return res.status(403).json({
                success: false,
                error: '访问被拒绝',
            });
        }
        await db.delete(canvases).where(eq(canvases.id, canvasId));
        scheduleSave();
        log('DELETE canvas - Success', { canvasId });
        res.json({
            success: true,
            data: { message: 'Canvas deleted' },
        });
    }
    catch (error) {
        log('DELETE canvas - Error', { canvasId, error: error instanceof Error ? error.message : String(error) });
        throw error;
    }
}));
canvasRouter.post('/:id/data', authenticate, asyncHandler(async (req, res) => {
    const canvasId = parseInt(req.params.id);
    const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
    });
    if (!canvas) {
        return res.status(404).json({
            success: false,
            error: '画布未找到',
        });
    }
    const canvasProjectId = canvas.project_id || canvas.projectId;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, canvasProjectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const { nodes, groups, domains, connections } = req.body;
    const jsonString = JSON.stringify({ nodes, groups, domains, connections });
    const utf8Bytes = new TextEncoder().encode(jsonString);
    const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
    const base64Data = btoa(binaryString);
    await db
        .update(canvases)
        .set({
        yjsData: base64Data,
        updatedAt: Math.floor(Date.now() / 1000),
    })
        .where(eq(canvases.id, canvasId));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Canvas data saved' },
    });
}));
canvasRouter.get('/:projectId/folders', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const projectFolders = await db.query.folders.findMany({
        where: eq(folders.projectId, projectId),
        orderBy: (folders, { asc }) => [asc(folders.sortOrder)],
    });
    res.json({
        success: true,
        data: projectFolders,
    });
}));
canvasRouter.post('/:projectId/folders', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.projectId);
    const { name, parentId } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const result = await db
        .insert(folders)
        .values({
        name,
        projectId,
        parentId: parentId || null,
    })
        .returning();
    const [newFolder] = result || [];
    scheduleSave();
    res.json({
        success: true,
        data: newFolder,
    });
}));
canvasRouter.put('/folders/:id', authenticate, asyncHandler(async (req, res) => {
    const folderId = parseInt(req.params.id);
    const { name } = req.body;
    const folder = await db.query.folders.findFirst({
        where: eq(folders.id, folderId),
    });
    if (!folder) {
        return res.status(404).json({
            success: false,
            error: '文件夹未找到',
        });
    }
    const folderProjectId = folder.project_id || folder.projectId;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, folderProjectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const result = await db
        .update(folders)
        .set({
        name: name || folder.name,
    })
        .where(eq(folders.id, folderId))
        .returning();
    const [updatedFolder] = result || [];
    scheduleSave();
    res.json({
        success: true,
        data: updatedFolder,
    });
}));
canvasRouter.delete('/folders/:id', authenticate, asyncHandler(async (req, res) => {
    const folderId = parseInt(req.params.id);
    const folder = await db.query.folders.findFirst({
        where: eq(folders.id, folderId),
    });
    if (!folder) {
        return res.status(404).json({
            success: false,
            error: '文件夹未找到',
        });
    }
    const folderProjectId = folder.project_id || folder.projectId;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, folderProjectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const projectOwnerId = project.owner_id || project.ownerId;
    if (projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const folderIdsToDelete = [];
    const queue = [folderId];
    while (queue.length > 0) {
        const currentId = queue.shift();
        folderIdsToDelete.push(currentId);
        const childFolders = await db.query.folders.findMany({
            where: eq(folders.parentId, currentId),
        });
        for (const child of childFolders) {
            queue.push(child.id);
        }
    }
    log('DELETE folder - Deleting folders and their canvases', {
        folderId,
        totalFolders: folderIdsToDelete.length,
        folderIds: folderIdsToDelete,
    });
    if (folderIdsToDelete.length > 0) {
        await db.delete(canvases).where(inArray(canvases.folderId, folderIdsToDelete));
    }
    for (let i = folderIdsToDelete.length - 1; i >= 0; i--) {
        await db.delete(folders).where(eq(folders.id, folderIdsToDelete[i]));
    }
    log('DELETE folder - Success', { folderId, foldersDeleted: folderIdsToDelete.length });
    res.json({
        success: true,
        data: {
            message: 'Folder deleted',
            foldersDeleted: folderIdsToDelete.length,
        },
    });
}));
