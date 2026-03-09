-- AI Conversations table for persistent chat history per canvas
CREATE TABLE `ai_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`messages` text NOT NULL,
	`context_divider_index` integer DEFAULT -1 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `ai_conversations_canvas_user_idx` ON `ai_conversations` (`canvas_id`,`user_id`);