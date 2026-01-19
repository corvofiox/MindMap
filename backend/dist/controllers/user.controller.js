import { Router } from 'express';
import bcrypt from 'bcrypt';
import { db, scheduleSave } from '../database/connection.js';
import { users, projects, projectMembers, groupMembers, nodeCards, files, canvases, folders, canvasRecycleBin, nodePoolFolders } from '../database/schema.js';
import { eq, and } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
export const userRouter = Router();
userRouter.get('/profile', authenticate, asyncHandler(async (req, res) => {
    const user = await db.query.users.findFirst({
        where: eq(users.id, req.user.id),
    });
    if (!user) {
        return res.status(404).json({
            success: false,
            error: '用户不存在',
        });
    }
    res.json({
        success: true,
        data: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            avatar: user.avatar,
            created_at: user.createdAt,
            updated_at: user.updatedAt,
        },
    });
}));
userRouter.put('/profile', authenticate, asyncHandler(async (req, res) => {
    const { nickname, avatar } = req.body;
    const [updatedUser] = await db
        .update(users)
        .set({
        nickname: nickname || null,
        avatar: avatar || null,
        updatedAt: Math.floor(Date.now() / 1000),
    })
        .where(eq(users.id, req.user.id))
        .returning();
    res.json({
        success: true,
        data: {
            id: updatedUser.id,
            email: updatedUser.email,
            nickname: updatedUser.nickname,
            avatar: updatedUser.avatar,
            created_at: updatedUser.createdAt,
            updated_at: updatedUser.updatedAt,
        },
    });
}));
userRouter.post('/avatar', authenticate, asyncHandler(async (req, res) => {
    res.json({
        success: false,
        error: 'Use /api/files/upload for file uploads',
    });
}));
userRouter.put('/password', authenticate, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({
            success: false,
            error: '当前密码和新密码不能为空',
        });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({
            success: false,
            error: '新密码长度不能少于6个字符',
        });
    }
    const userList = await db
        .select()
        .from(users)
        .where(eq(users.id, req.user.id));
    const user = userList[0];
    if (!user || !user.password) {
        return res.status(404).json({
            success: false,
            error: '用户不存在',
        });
    }
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
        return res.status(401).json({
            success: false,
            error: '当前密码不正确',
        });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db
        .update(users)
        .set({
        password: hashedPassword,
        updatedAt: Math.floor(Date.now() / 1000),
    })
        .where(eq(users.id, req.user.id));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Password updated successfully' },
    });
}));
userRouter.delete('/account', authenticate, asyncHandler(async (req, res) => {
    const { password, confirmation } = req.body;
    if (!confirmation || confirmation !== 'DELETE') {
        return res.status(400).json({
            success: false,
            error: '请输入DELETE确认删除账户',
        });
    }
    const userList = await db
        .select()
        .from(users)
        .where(eq(users.id, req.user.id));
    const user = userList[0];
    if (!user || !user.password) {
        return res.status(404).json({
            success: false,
            error: '用户未找到',
        });
    }
    if (password) {
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: '密码不正确',
            });
        }
    }
    const userId = req.user.id;
    await db
        .delete(projectMembers)
        .where(and(eq(projectMembers.userId, userId), eq(projectMembers.role, 'viewer')));
    await db
        .delete(projectMembers)
        .where(and(eq(projectMembers.userId, userId), eq(projectMembers.role, 'editor')));
    await db
        .delete(groupMembers)
        .where(eq(groupMembers.userId, userId));
    const ownedProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.ownerId, userId));
    for (const project of ownedProjects) {
        await db
            .delete(projectMembers)
            .where(eq(projectMembers.projectId, project.id));
        const projectCanvases = await db
            .select()
            .from(canvases)
            .where(eq(canvases.projectId, project.id));
        for (const canvas of projectCanvases) {
            await db
                .delete(canvasRecycleBin)
                .where(eq(canvasRecycleBin.canvasId, canvas.id));
        }
        await db
            .delete(canvases)
            .where(eq(canvases.projectId, project.id));
        await db
            .delete(folders)
            .where(eq(folders.projectId, project.id));
        await db
            .delete(nodePoolFolders)
            .where(eq(nodePoolFolders.projectId, project.id));
        await db
            .delete(nodeCards)
            .where(eq(nodeCards.projectId, project.id));
        await db
            .delete(files)
            .where(eq(files.projectId, project.id));
        await db
            .delete(projects)
            .where(eq(projects.id, project.id));
    }
    await db
        .delete(files)
        .where(eq(files.uploaderId, userId));
    await db
        .delete(nodeCards)
        .where(eq(nodeCards.createdBy, userId));
    await db
        .delete(canvasRecycleBin)
        .where(eq(canvasRecycleBin.deletedBy, userId));
    await db
        .delete(users)
        .where(eq(users.id, userId));
    scheduleSave();
    res.json({
        success: true,
        data: { message: 'Account deleted successfully' },
    });
}));
