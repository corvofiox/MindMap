CREATE TABLE `ai_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`messages` text NOT NULL,
	`context_divider_index` integer DEFAULT -1 NOT NULL,
	`updated_at` integer DEFAULT strftime('%s', 'now'),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_temp_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`uploader_id` integer NOT NULL,
	`canvas_id` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT strftime('%s', 'now'),
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE no action
);
