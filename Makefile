# AI Meter — build & marketplace publish
#
# Publishing needs a one-time setup:
#   1. Create a publisher at https://marketplace.visualstudio.com/manage
#      (must match "publisher" in package.json)
#   2. Create an Azure DevOps PAT (org: All accessible, scope: Marketplace > Manage)
#   3. Either 'make login' once, or put VSCE_PAT=<token> in .env
#
-include .env
export VSCE_PAT

VSCE = npx --yes @vscode/vsce
NAME = $(shell node -p "require('./package.json').name")
VERSION = $(shell node -p "require('./package.json').version")
VSIX = $(NAME)-$(VERSION).vsix
PUBLISHER = $(shell node -p "require('./package.json').publisher")

.PHONY: package install login publish publish-patch publish-minor clean

# Build the .vsix
package:
	$(VSCE) package

# Install the packaged .vsix into local VS Code / code-server
install: package
	@command -v code-server >/dev/null 2>&1 && code-server --install-extension $(VSIX) --force \
		|| code --install-extension $(VSIX) --force

# One-time: store the marketplace PAT for $(PUBLISHER)
login:
	$(VSCE) login $(PUBLISHER)

# Publish the current version from package.json
publish:
	$(VSCE) publish

# Bump version (also creates the git commit + tag), then publish
publish-patch:
	$(VSCE) publish patch

publish-minor:
	$(VSCE) publish minor

clean:
	rm -f *.vsix
