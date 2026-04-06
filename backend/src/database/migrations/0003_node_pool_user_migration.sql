-- Migration: Change node pool from project-based to user-based
-- This makes node pool account-specific, independent of projects

-- Step 1: Create new node_pool_folders table with user_id
CREATE TABLE `node_pool_folders_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer REFERENCES `node_pool_folders_new`(`id`),
	`sort_order` integer DEFAULT 0 NOT NULL,
	`collapsed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT strftime('%s', 'now'),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- Step 2: Create new node_cards table with user_id
CREATE TABLE `node_cards_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`color` text DEFAULT '#ffffff' NOT NULL,
	`tags` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`created_by` integer NOT NULL,
	`folder_id` integer REFERENCES `node_pool_folders_new`(`id`),
	`description` text,
	`thumbnail` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT strftime('%s', 'now'),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

-- Step 3: Migrate node_pool_folders data
-- Map project_id to user_id via projects.owner_id
-- For orphaned folders (project doesn't exist), try to find user from related node_cards
-- Only migrate folders that have a valid user_id
INSERT INTO `node_pool_folders_new` (`id`, `user_id`, `name`, `parent_id`, `sort_order`, `collapsed`, `created_at`)
SELECT 
	npf.id,
	COALESCE(p.owner_id, (
		SELECT nc.created_by 
		FROM node_cards nc 
		WHERE nc.folder_id = npf.id 
		LIMIT 1
	)) as user_id,
	npf.name,
	npf.parent_id,
	npf.sort_order,
	npf.collapsed,
	npf.created_at
FROM `node_pool_folders` npf
LEFT JOIN `projects` p ON npf.project_id = p.id
WHERE COALESCE(p.owner_id, (
	SELECT nc.created_by 
	FROM node_cards nc 
	WHERE nc.folder_id = npf.id 
	LIMIT 1
)) IS NOT NULL;
--> statement-breakpoint

-- Step 4: Migrate node_cards data
-- Map project_id to user_id via projects.owner_id
-- Fallback to created_by if project doesn't exist (orphaned records)
INSERT INTO `node_cards_new` (`id`, `user_id`, `name`, `content`, `type`, `color`, `tags`, `use_count`, `created_by`, `folder_id`, `description`, `thumbnail`, `sort_order`, `created_at`)
SELECT 
	nc.id,
	COALESCE(p.owner_id, nc.created_by) as user_id,
	nc.name,
	nc.content,
	nc.type,
	nc.color,
	nc.tags,
	nc.use_count,
	nc.created_by,
	nc.folder_id,
	nc.description,
	nc.thumbnail,
	nc.sort_order,
	nc.created_at
FROM `node_cards` nc
LEFT JOIN `projects` p ON nc.project_id = p.id;
--> statement-breakpoint

-- Step 5: Drop old tables
DROP TABLE `node_cards`;
--> statement-breakpoint

DROP TABLE `node_pool_folders`;
--> statement-breakpoint

-- Step 6: Rename new tables to original names
ALTER TABLE `node_cards_new` RENAME TO `node_cards`;
--> statement-breakpoint

ALTER TABLE `node_pool_folders_new` RENAME TO `node_pool_folders`;
