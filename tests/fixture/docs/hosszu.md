# Hosszú sor

```bash
docker run --rm -v "$PWD:/data" -e GIT_URL=https://gitlab.example.com/group/subgroup/very-long-repository-name.git -e GIT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx -e GIT_DOCS_PATH=docs/very/long/path -p 8080:8080 markdown-manager:latest --some-very-long-option=value
```

```
plain: docker run --rm -v "$PWD:/data" -e GIT_URL=https://gitlab.example.com/group/subgroup/very-long-repository-name.git -e GIT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx -e GIT_DOCS_PATH=docs/very/long/path -p 8080:8080
```
