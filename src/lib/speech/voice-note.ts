import { deleteChatFile } from "@/lib/storage/chat-files-store";
import { transcribeAudioFile } from "@/lib/speech/transcriber";

/**
 * Turn a recording into text and throw the recording away.
 *
 * The audio has exactly one job and it is done the moment the transcript
 * exists. Keeping it costs a row in the chat's file list, and that list is
 * rebuilt into the prompt on every single turn, so somebody who talks instead
 * of typing accumulates a table of `.ogg` paths that grows without limit and
 * that nobody will ever open.
 *
 * This lives in one place because there are two ways a voice message arrives -
 * the workspace's own bot and the deployment's relay - and the first version of
 * this deleted the recording on only one of them. The path nobody patched was
 * the one the person testing it was actually using.
 *
 * A failed transcription keeps the file: then the audio is the only record, and
 * a retry needs it.
 */
export async function transcribeVoiceNote(params: {
  chatId: string;
  filePath: string;
  savedName: string;
  mimeType?: string;
  language?: string;
}): Promise<string> {
  const transcription = await transcribeAudioFile({
    filePath: params.filePath,
    filename: params.savedName,
    mimeType: params.mimeType,
    language: params.language,
  });

  // Best effort: a recording left behind is untidy, never a reason to lose a
  // transcript the user is waiting for.
  await deleteChatFile(params.chatId, params.savedName).catch(() => undefined);

  return transcription.transcript;
}
