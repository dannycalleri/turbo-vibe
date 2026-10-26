FROM python:3.13-slim
WORKDIR /app
COPY app.py ./
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID
EXPOSE 3000
USER nobody
CMD ["python", "app.py"]
