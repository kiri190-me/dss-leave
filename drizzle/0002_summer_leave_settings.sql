CREATE TABLE "web_leave_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"summer_days" numeric(5, 1) DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_leave_settings_singleton_ck" CHECK ("web_leave_settings"."id" = 1),
	CONSTRAINT "web_leave_settings_summer_days_ck" CHECK ("web_leave_settings"."summer_days" >= 0)
);
