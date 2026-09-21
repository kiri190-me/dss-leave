CREATE TABLE "web_approval_route_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_no" integer NOT NULL,
	"approver_employee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text
);
--> statement-breakpoint
ALTER TABLE "web_approval_steps" ADD COLUMN "approver_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "web_approval_route_steps" ADD CONSTRAINT "web_approval_route_steps_approver_employee_id_web_employees_id_fk" FOREIGN KEY ("approver_employee_id") REFERENCES "public"."web_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_approval_route_steps_employee_uq" ON "web_approval_route_steps" USING btree ("approver_employee_id") WHERE "web_approval_route_steps"."is_deleted" = false;--> statement-breakpoint
CREATE INDEX "web_approval_route_steps_alive_idx" ON "web_approval_route_steps" USING btree ("step_no") WHERE "web_approval_route_steps"."is_deleted" = false;--> statement-breakpoint
ALTER TABLE "web_approval_steps" ADD CONSTRAINT "web_approval_steps_approver_employee_id_web_employees_id_fk" FOREIGN KEY ("approver_employee_id") REFERENCES "public"."web_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_approval_steps_pending_approver_idx" ON "web_approval_steps" USING btree ("approver_employee_id") WHERE "web_approval_steps"."is_deleted" = false and "web_approval_steps"."status" = 'PENDING';