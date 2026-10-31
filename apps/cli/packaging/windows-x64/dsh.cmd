@echo off
rem DeepSeek Harness CLI launcher shipped with the offline package. Absolute sibling
rem paths only: the machine needs nothing on PATH except this script.
"%~dp0runtime\primary-runtime\dependencies\node\bin\node.exe" "%~dp0dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
