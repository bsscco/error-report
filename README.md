# error-report
Error reporting tool that is running in Slack. I made for my colleagues.

### NPM libraries
- axios
- express
- body-parser

### Using APIs
- Jira REST API
- Slack REST API

### Crontab for restarting when process killed. 
- ```chmod 777 chkproc.sh```
- ```* * * * * /home/bsscco/error-report/chkproc.sh > /home/bsscco/error-report/crontab-chkproc.log 2>&1```
