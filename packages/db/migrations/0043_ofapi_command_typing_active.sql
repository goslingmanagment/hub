ALTER TABLE "ofapi_commands"
	DROP CONSTRAINT IF EXISTS "ofapi_commands_kind_check";

ALTER TABLE "ofapi_commands"
	ADD CONSTRAINT "ofapi_commands_kind_check"
	CHECK ("kind" IN ('send_text_message_v1', 'typing_active_v1'));
