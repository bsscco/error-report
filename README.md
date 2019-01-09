# error-report
슬랙에서 오류리포팅 하기

### 라이브러리
- axios
- express
- body-parser

### API
- Jira REST API
- Slack REST API

### crontab
- ```chmod 777 chkproc.sh```
- ```* * * * * /home/bsscco/error-report/chkproc.sh > /home/bsscco/error-report/crontab-chkproc.log 2>&1```
