//! The only GitHub requests temper-triage can make.
//!
//! Every route is built from the configured org and a validated repository
//! name; there is no generic request. Closing, editing or writing to an
//! issue other than the offered one cannot be expressed.

/// A repository name as GitHub allows it (the same rule warte applies).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoName(String);

impl RepoName {
    pub fn parse(s: &str) -> Option<RepoName> {
        let ok = (1..=100).contains(&s.len())
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        ok.then(|| RepoName(s.to_string()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The App itself, for its bot login (App JWT).
    App,
    /// The App's installation on the org (App JWT).
    OrgInstallation,
    /// Mint an installation token (App JWT).
    InstallationToken(u64),
    Repo(RepoName),
    Issue(RepoName, u64),
    /// One page of the issue's comments, 100 per page.
    Comments(RepoName, u64, u32),
    PostComment(RepoName, u64),
    AddLabels(RepoName, u64),
}

impl Route {
    /// Method and path below the API base.
    pub fn request(&self, org: &str) -> (Method, String) {
        use Method::*;
        match self {
            Route::App => (Get, "/app".into()),
            Route::OrgInstallation => (Get, format!("/orgs/{org}/installation")),
            Route::InstallationToken(id) => {
                (Post, format!("/app/installations/{id}/access_tokens"))
            }
            Route::Repo(r) => (Get, format!("/repos/{org}/{}", r.as_str())),
            Route::Issue(r, n) => (Get, format!("/repos/{org}/{}/issues/{n}", r.as_str())),
            Route::Comments(r, n, p) => (
                Get,
                format!(
                    "/repos/{org}/{}/issues/{n}/comments?per_page=100&page={p}",
                    r.as_str()
                ),
            ),
            Route::PostComment(r, n) => (
                Post,
                format!("/repos/{org}/{}/issues/{n}/comments", r.as_str()),
            ),
            Route::AddLabels(r, n) => (
                Post,
                format!("/repos/{org}/{}/issues/{n}/labels", r.as_str()),
            ),
        }
    }

    /// Authenticated with the App JWT rather than an installation token.
    pub fn app_auth(&self) -> bool {
        matches!(
            self,
            Route::App | Route::OrgInstallation | Route::InstallationToken(_)
        )
    }

    /// Changes something on GitHub.
    pub fn writes(&self) -> bool {
        matches!(self, Route::PostComment(..) | Route::AddLabels(..))
    }
}
