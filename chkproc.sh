daemon=`netstat -tlnp | grep :::10000 | wc -l`
if [ "$daemon" -eq "0" ] ; then
        nohup node /home/bsscco/bugs/app.js &
fi