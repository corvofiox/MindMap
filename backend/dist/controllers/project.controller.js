import { Router } from 'express';
import { db, scheduleSave } from '../database/connection.js';
import { projects, projectMembers, nodeCards, nodePoolFolders } from '../database/schema.js';
import { eq, and } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { transformResponse, transformResponseArray } from '../utils/transformResponse.js';
export const projectRouter = Router();
projectRouter.get('/', authenticate, asyncHandler(async (req, res) => {
    const userProjects = await db.query.projects.findMany({
        where: eq(projects.ownerId, req.user.id),
        orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
    });
    const transformedProjects = transformResponseArray(userProjects, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedProjects,
    });
}));
projectRouter.get('/:id', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const transformedProject = transformResponse(project, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedProject,
    });
}));
projectRouter.post('/', authenticate, asyncHandler(async (req, res) => {
    const { name, description, is_public } = req.body;
    const [newProject] = await db
        .insert(projects)
        .values({
        name,
        description: description || null,
        ownerId: req.user.id,
        isPublic: is_public || false,
    })
        .returning();
    scheduleSave();
    const transformedProject = transformResponse(newProject, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedProject,
    });
}));
projectRouter.put('/:id', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { name, description, thumbnail } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    const projectOwnerId = project.owner_id || project.ownerId;
    if (!project || projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const [updatedProject] = await db
        .update(projects)
        .set({
        name: name || project.name,
        description: description !== undefined ? description : project.description,
        thumbnail: thumbnail || project.thumbnail,
        updatedAt: Math.floor(Date.now() / 1000),
    })
        .where(eq(projects.id, projectId))
        .returning();
    scheduleSave();
    const transformedProject = transformResponse(updatedProject, ['createdAt', 'updatedAt']);
    res.json({
        success: true,
        data: transformedProject,
    });
}));
projectRouter.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
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
    await db.delete(projects).where(eq(projects.id, projectId));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Project deleted' },
    });
}));
projectRouter.post('/:id/members', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { userId, role } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    const projectOwnerId = project.owner_id || project.ownerId;
    if (!project || projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    const [newMember] = await db
        .insert(projectMembers)
        .values({
        projectId,
        userId,
        role: role || 'viewer',
    })
        .returning();
    scheduleSave();
    res.json({
        success: true,
        data: newMember,
    });
}));
projectRouter.delete('/:id/members/:userId', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    const projectOwnerId = project.owner_id || project.ownerId;
    if (!project || projectOwnerId !== req.user.id) {
        return res.status(403).json({
            success: false,
            error: '访问被拒绝',
        });
    }
    await db
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Member removed' },
    });
}));
projectRouter.get('/:id/node-pool', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const nodes = await db.query.nodeCards.findMany({
        where: eq(nodeCards.projectId, projectId),
        orderBy: (nodeCards, { desc }) => [desc(nodeCards.useCount)],
    });
    const transformedNodes = transformResponseArray(nodes, ['createdAt']);
    res.json({
        success: true,
        data: transformedNodes,
    });
}));
projectRouter.post('/:id/node-pool', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { name, content, type, color, tags, image_url } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const [newNode] = await db
        .insert(nodeCards)
        .values({
        projectId,
        name,
        content,
        type: type || 'text',
        color: color || '#ffffff',
        tags: tags || null,
        thumbnail: image_url || null,
        createdBy: req.user.id,
    })
        .returning();
    scheduleSave();
    const transformedNode = transformResponse(newNode, ['createdAt']);
    res.json({
        success: true,
        data: transformedNode,
    });
}));
projectRouter.delete('/node-pool/:nodeId', authenticate, asyncHandler(async (req, res) => {
    const nodeId = parseInt(req.params.nodeId);
    const node = await db.query.nodeCards.findFirst({
        where: eq(nodeCards.id, nodeId),
    });
    if (!node) {
        return res.status(404).json({
            success: false,
            error: '节点未找到',
        });
    }
    await db.delete(nodeCards).where(eq(nodeCards.id, nodeId));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Node removed from pool' },
    });
}));
projectRouter.put('/node-pool/:id', authenticate, asyncHandler(async (req, res) => {
    const nodeId = parseInt(req.params.id);
    const { name, description, folderId, sortOrder } = req.body;
    const node = await db.query.nodeCards.findFirst({
        where: eq(nodeCards.id, nodeId),
    });
    if (!node) {
        return res.status(404).json({
            success: false,
            error: '节点未找到',
        });
    }
    const nodeSortOrder = node.sort_order || node.sortOrder || 0;
    const [updatedNode] = await db
        .update(nodeCards)
        .set({
        name: name !== undefined ? name : node.name,
        description: description !== undefined ? description : node.description,
        folderId: folderId !== undefined ? folderId : node.folderId,
        sortOrder: sortOrder !== undefined ? sortOrder : nodeSortOrder,
    })
        .where(eq(nodeCards.id, nodeId))
        .returning();
    scheduleSave();
    const transformedNode = transformResponse(updatedNode, ['createdAt']);
    res.json({
        success: true,
        data: transformedNode,
    });
}));
projectRouter.post('/node-pool/:id/increment-use', authenticate, asyncHandler(async (req, res) => {
    const nodeId = parseInt(req.params.id);
    const node = await db.query.nodeCards.findFirst({
        where: eq(nodeCards.id, nodeId),
    });
    if (!node) {
        return res.status(404).json({
            success: false,
            error: '节点未找到',
        });
    }
    const currentUseCount = node.use_count || node.useCount || 0;
    const [updatedNode] = await db
        .update(nodeCards)
        .set({
        useCount: currentUseCount + 1,
    })
        .where(eq(nodeCards.id, nodeId))
        .returning();
    scheduleSave();
    const transformedNode = transformResponse(updatedNode, ['createdAt']);
    res.json({
        success: true,
        data: transformedNode,
    });
}));
projectRouter.get('/:id/node-pool-folders', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const folders = await db.query.nodePoolFolders.findMany({
        where: eq(nodePoolFolders.projectId, projectId),
        orderBy: (nodePoolFolders, { asc }) => [asc(nodePoolFolders.sortOrder)],
    });
    const transformedFolders = transformResponseArray(folders, ['createdAt']);
    res.json({
        success: true,
        data: transformedFolders,
    });
}));
projectRouter.post('/:id/node-pool-folders', authenticate, asyncHandler(async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { name, parentId, sortOrder, collapsed } = req.body;
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
    });
    if (!project) {
        return res.status(404).json({
            success: false,
            error: '项目未找到',
        });
    }
    const result = await db
        .insert(nodePoolFolders)
        .values({
        projectId,
        name,
        parentId: parentId || null,
        sortOrder: sortOrder || 0,
        collapsed: collapsed ?? true,
    })
        .returning();
    const [newFolder] = result || [];
    scheduleSave();
    const transformedFolder = transformResponse(newFolder, ['createdAt']);
    res.json({
        success: true,
        data: transformedFolder,
    });
}));
projectRouter.put('/node-pool-folders/:id', authenticate, asyncHandler(async (req, res) => {
    const folderId = parseInt(req.params.id);
    const { name, parentId, sortOrder, collapsed } = req.body;
    const folder = await db.query.nodePoolFolders.findFirst({
        where: eq(nodePoolFolders.id, folderId),
    });
    if (!folder) {
        return res.status(404).json({
            success: false,
            error: '文件夹未找到',
        });
    }
    const result = await db
        .update(nodePoolFolders)
        .set({
        name: name !== undefined ? name : folder.name,
        parentId: parentId !== undefined ? parentId : folder.parentId,
        sortOrder: sortOrder !== undefined ? sortOrder : folder.sortOrder,
        collapsed: collapsed !== undefined ? collapsed : folder.collapsed,
    })
        .where(eq(nodePoolFolders.id, folderId))
        .returning();
    const [updatedFolder] = result || [];
    scheduleSave();
    const transformedFolder = transformResponse(updatedFolder, ['createdAt']);
    res.json({
        success: true,
        data: transformedFolder,
    });
}));
projectRouter.delete('/node-pool-folders/:id', authenticate, asyncHandler(async (req, res) => {
    const folderId = parseInt(req.params.id);
    const folder = await db.query.nodePoolFolders.findFirst({
        where: eq(nodePoolFolders.id, folderId),
    });
    if (!folder) {
        return res.status(404).json({
            success: false,
            error: '文件夹未找到',
        });
    }
    await db
        .update(nodeCards)
        .set({ folderId: null })
        .where(eq(nodeCards.folderId, folderId));
    await db.delete(nodePoolFolders).where(eq(nodePoolFolders.id, folderId));
    res.json({
        success: true,
        data: { message: 'Folder deleted' },
    });
}));
