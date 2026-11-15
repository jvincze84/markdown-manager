#!/bin/sh
# Git GIT_ASKPASS helper: a token-t környezeti változóból adja át, soha nem kerül lemezre.
case "$1" in
  Username*) echo "${GIT_USERNAME:-oauth2}" ;;
  *) echo "${GIT_TOKEN}" ;;
esac
