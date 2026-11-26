FROM python:3.13-alpine
WORKDIR /app
COPY server.py ./
COPY static/ static/
RUN mkdir -p /data && chown nobody:nogroup /data
USER nobody
ENV DATA_DIR=/data PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["python", "server.py"]

