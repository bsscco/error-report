# bugs
슬랙에서 버그리포팅 하기

### 라이브러리
- axios
- express
- body-parser

### API
- Jira REST API
- Slack REST API

### crontab
- ```chmod 777 chkproc.sh```
- ```* * * * * /home/bsscco/bugs/chkproc.sh > /home/bsscco/bugs/crontab-chkproc.log 2>&1```
