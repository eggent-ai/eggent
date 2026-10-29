export const EMAIL_ROOT_PATH = "/dashboard/email";

export function emailLetterPath(letterId: number): string {
  return `${EMAIL_ROOT_PATH}/${letterId}`;
}

export function emailFolderPath(folder: string): string {
  return folder === "inbox" ? EMAIL_ROOT_PATH : `${EMAIL_ROOT_PATH}?folder=${encodeURIComponent(folder)}`;
}
