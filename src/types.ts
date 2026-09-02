// Typed subset of the Forgejo v1 API entities.
// Only the fields we actually consume are declared; the rest is ignored.

export interface ForgejoUser {
  id: number;
  login: string;
  full_name?: string;
  email?: string;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color?: string;
}

export interface ForgejoIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  user?: ForgejoUser;
  labels?: ForgejoLabel[] | null;
  assignees?: ForgejoUser[] | null;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  /** Non-null when the "issue" is in fact a pull request. */
  pull_request?: unknown | null;
}

export interface ForgejoComment {
  id: number;
  user?: ForgejoUser;
  body: string;
  created_at: string;
  html_url: string;
}

/** One end of a pull request (source or target branch). */
export interface ForgejoPullRef {
  label: string;
  ref: string;
  sha: string;
}

export interface ForgejoPullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  user?: ForgejoUser;
  head?: ForgejoPullRef;
  base?: ForgejoPullRef;
  /** null until Forgejo has computed mergeability. */
  mergeable?: boolean | null;
  merged: boolean;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  html_url: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface ForgejoBranch {
  name: string;
  commit?: { id?: string; message?: string; timestamp?: string };
  protected?: boolean;
}

export interface ForgejoCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
  };
  author?: ForgejoUser | null;
}

export interface ForgejoRepo {
  id: number;
  full_name: string;
  description?: string;
  private: boolean;
  fork: boolean;
  default_branch: string;
  updated_at: string;
  html_url: string;
}

export interface ForgejoFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  encoding?: string;
  content?: string;
  html_url?: string;
}
