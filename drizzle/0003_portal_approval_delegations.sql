CREATE TABLE "web_portal_approval_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delegator_employee_id" uuid NOT NULL,
	"delegate_employee_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"revoked_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_portal_approval_delegations_period_ck" CHECK ("web_portal_approval_delegations"."ends_at" > "web_portal_approval_delegations"."starts_at"),
	CONSTRAINT "web_portal_approval_delegations_self_ck" CHECK ("web_portal_approval_delegations"."delegate_employee_id" <> "web_portal_approval_delegations"."delegator_employee_id")
);
--> statement-breakpoint
ALTER TABLE "web_portal_approval_delegations" ADD CONSTRAINT "web_portal_approval_delegations_delegator_fk" FOREIGN KEY ("delegator_employee_id") REFERENCES "public"."web_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_portal_approval_delegations" ADD CONSTRAINT "web_portal_approval_delegations_delegate_fk" FOREIGN KEY ("delegate_employee_id") REFERENCES "public"."web_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_portal_approval_delegations_delegate_idx" ON "web_portal_approval_delegations" USING btree ("delegate_employee_id","revoked_at","ends_at");